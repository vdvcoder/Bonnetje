//! Client minimal de Claude, par deux chemins au choix :
//! - l'API (Messages API, HTTP direct : pas de SDK Rust officiel) : `ANTHROPIC_API_KEY` pour
//!   l'API d'Anthropic, ou `ANTHROPIC_BASE_URL` vers un serveur compatible (sans clé pour un
//!   serveur local) ;
//! - la CLI Claude Code (`claude -p`), qui utilise sa propre connexion (abonnement Claude).

use std::io::{Read, Write};
use std::process::{Command, Stdio};
use std::sync::Mutex;
use std::time::{Duration, Instant};

use anyhow::{Context, Result, bail};
use serde::de::DeserializeOwned;
use serde_json::{Value, json};

use crate::i18n::t;

const DEFAULT_API_URL: &str = "https://api.anthropic.com/v1/messages";
const DEFAULT_MODEL: &str = "claude-haiku-5-5";
const DEFAULT_TIMEOUT: Duration = Duration::from_secs(120);

/// URL des messages : `ANTHROPIC_BASE_URL` (compatible Claude Code) ou Anthropic par défaut.
fn api_url() -> String {
    api_url_from(std::env::var("ANTHROPIC_BASE_URL").ok().as_deref())
}

/// Sans `ANTHROPIC_BASE_URL` (ou avec une valeur vide) : l'API d'Anthropic. Sinon `/v1/messages`
/// est ajouté quand la valeur ne le termine pas (la barre oblique finale est tolérée).
fn api_url_from(value: Option<&str>) -> String {
    match value.map(str::trim).filter(|u| !u.is_empty()) {
        Some(u) => {
            let u = u.trim_end_matches('/');
            if u.ends_with("/v1/messages") { u.to_owned() } else { format!("{u}/v1/messages") }
        }
        None => DEFAULT_API_URL.to_owned(),
    }
}

/// Délai d'un appel Claude : `PRINTR_CLAUDE_TIMEOUT_SECS` (défaut 120 s).
fn api_timeout() -> Duration {
    timeout_from(std::env::var("PRINTR_CLAUDE_TIMEOUT_SECS").ok().as_deref())
}

/// Valeur absente, illisible ou nulle : le défaut est conservé (un délai de 0 s ferait échouer
/// chaque appel).
fn timeout_from(value: Option<&str>) -> Duration {
    value
        .and_then(|s| s.trim().parse::<u64>().ok())
        .filter(|&s| s > 0)
        .map(Duration::from_secs)
        .unwrap_or(DEFAULT_TIMEOUT)
}

/// Une seule CLI à la fois : chaque appel lance un processus Node complet, gourmand en mémoire.
static CLI_LOCK: Mutex<()> = Mutex::new(());

pub struct Claude {
    model: String,
    backend: Backend,
}

enum Backend {
    /// `api_key` : `None` pour un serveur compatible sans clé (`ANTHROPIC_BASE_URL` local).
    Api {
        api_key: Option<String>,
        agent: ureq::Agent,
    },
    Cli {
        program: String,
    },
}

impl Claude {
    /// Choisit le chemin selon `PRINTR_CLAUDE_BACKEND` (`auto` par défaut, `api` ou `cli`) :
    /// l'API si `ANTHROPIC_API_KEY` ou `ANTHROPIC_BASE_URL` est définie (un serveur compatible
    /// local n'a pas besoin de clé), sinon la CLI si elle est installée (`PRINTR_CLAUDE_CLI`,
    /// `claude` par défaut). `PRINTR_CLAUDE_MODEL` choisit le modèle.
    pub fn from_env() -> Option<Self> {
        let model = std::env::var("PRINTR_CLAUDE_MODEL").unwrap_or_else(|_| DEFAULT_MODEL.to_owned());
        let api_key = std::env::var("ANTHROPIC_API_KEY").ok().filter(|k| !k.is_empty());
        let custom_url = std::env::var("ANTHROPIC_BASE_URL").ok().is_some_and(|u| !u.trim().is_empty());
        let wanted = std::env::var("PRINTR_CLAUDE_BACKEND").unwrap_or_default().trim().to_ascii_lowercase();
        let backend = match (wanted.as_str(), api_key.is_some(), custom_url) {
            ("cli", _, _) | ("" | "auto", false, false) => {
                let program = cli_program();
                if !installed(&program) {
                    return None;
                }
                Backend::Cli { program }
            }
            (_, true, _) => Backend::Api { api_key, agent: api_agent() },
            (_, false, true) => Backend::Api { api_key: None, agent: api_agent() },
            (_, false, false) => return None,
        };
        Some(Self { model, backend })
    }

    /// Zelfde verbinding, ander model.
    pub fn with_model(mut self, model: &str) -> Self {
        self.model = model.to_owned();
        self
    }

    pub fn model(&self) -> &str {
        &self.model
    }

    /// Chemin utilisé : « API » ou « CLI ».
    pub fn backend(&self) -> &'static str {
        match self.backend {
            Backend::Api { .. } => "API",
            Backend::Cli { .. } => "CLI",
        }
    }

    /// Envoie une requête et décode la réponse selon le schéma JSON fourni (sorties structurées).
    pub fn generate<T: DeserializeOwned>(&self, system: &str, prompt: &str, schema: Value, effort: &str) -> Result<T> {
        // Nederlands: de blokken gebruiken hun Engelse opdracht, omgezet naar het Nederlands.
        let (system, prompt) = if crate::i18n::nl() {
            (format!("{}\n\n{DUTCH}", system.replace("English", "Dutch")), prompt.replace("English", "Dutch"))
        } else {
            (system.to_owned(), prompt.to_owned())
        };
        let once = || match &self.backend {
            Backend::Api { api_key, agent } => {
                self.generate_api(agent, api_key.as_deref(), &system, &prompt, schema.clone(), effort)
            }
            Backend::Cli { program } => self.generate_cli(program, &system, &prompt, &schema, effort),
        };
        // Eén herkansing: de CLI geeft heel af en toe tekst in plaats van JSON terug.
        let value = once().or_else(|_| once())?;
        serde_json::from_value(value.clone())
            .with_context(|| tr!("JSON inattendu de Claude : {value}", "unexpected JSON from Claude: {value}", "onverwachte JSON van Claude: {value}"))
    }

    fn generate_api(
        &self,
        agent: &ureq::Agent,
        api_key: Option<&str>,
        system: &str,
        prompt: &str,
        schema: Value,
        effort: &str,
    ) -> Result<Value> {
        let mut body = json!({
            "model": self.model,
            "max_tokens": 16000,
            "system": system,
            "output_config": {
                "effort": effort,
                "format": { "type": "json_schema", "schema": schema },
            },
            "messages": [{ "role": "user", "content": prompt }],
        });
        let mut request = agent.post(api_url()).header("anthropic-version", "2023-06-01");
        // La clé, si elle existe : un serveur compatible local n'en a pas besoin.
        if let Some(key) = api_key {
            request = request.header("x-api-key", key);
        }
        // Relance automatique sur un autre modèle si le modèle principal refuse la requête.
        if supports_default_fallbacks(&self.model) {
            body["fallbacks"] = json!("default");
            request = request.header("anthropic-beta", "server-side-fallback-2026-07-01");
        }

        let mut response = request.send_json(&body).context(t("API Claude injoignable", "Claude API unreachable", "Claude-API onbereikbaar"))?;
        let status = response.status();
        let reply: Value = response
            .body_mut()
            .read_json()
            .context(t("réponse de l'API Claude illisible", "Claude API response unreadable", "antwoord van de Claude-API onleesbaar"))?;
        debug(&reply);
        if !status.is_success() {
            let message = reply["error"]["message"].as_str().unwrap_or(t("erreur inconnue", "unknown error", "onbekende fout"));
            bail!("{}", tr!("API Claude ({status}) : {message}", "Claude API ({status}): {message}", "Claude-API ({status}): {message}"));
        }
        match reply["stop_reason"].as_str() {
            Some("refusal") => bail!("{}", t("Claude a refusé la requête", "Claude refused the request", "Claude weigerde het verzoek")),
            Some("max_tokens") => bail!("{}", t("réponse de Claude tronquée", "Claude's response was cut short", "antwoord van Claude afgekapt")),
            _ => {}
        }

        let text: String = reply["content"]
            .as_array()
            .into_iter()
            .flatten()
            .filter(|block| block["type"] == "text")
            .filter_map(|block| block["text"].as_str())
            .collect();
        serde_json::from_str(&text)
            .with_context(|| tr!("JSON inattendu de Claude : {text}", "unexpected JSON from Claude: {text}", "onverwachte JSON van Claude: {text}"))
    }

    fn generate_cli(&self, program: &str, system: &str, prompt: &str, schema: &Value, effort: &str) -> Result<Value> {
        let _one_at_a_time = CLI_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        let mut cmd = Command::new(program);
        // Un simple appel au modèle : ni outils, ni réglages, ni CLAUDE.md, ni MCP, ni skills, ni
        // session gardée. Sans ça, le contexte embarqué multiplie le coût par cent.
        cmd.args(["-p", "--output-format", "json", "--no-session-persistence"])
            .args(["--tools", "", "--setting-sources", "", "--strict-mcp-config", "--disable-slash-commands"])
            .arg(format!("--model={}", self.model))
            .arg(format!("--effort={effort}"))
            .arg(format!("--json-schema={schema}"))
            .arg(format!("--system-prompt={system}"))
            .env("ENABLE_CLAUDEAI_MCP_SERVERS", "false")
            // La CLI doit utiliser sa connexion (abonnement), pas une clé API qui traînerait.
            .env_remove("ANTHROPIC_API_KEY")
            // Ook geen eigen API-adres: de CLI praat rechtstreeks met Anthropic.
            .env_remove("ANTHROPIC_BASE_URL")
            .current_dir(std::env::temp_dir())
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        let mut child = cmd.spawn().map_err(|e| match e.kind() {
            std::io::ErrorKind::NotFound => anyhow::anyhow!(
                "{}",
                tr!(
                    "CLI Claude introuvable (« {program} ») : installe-la ou définis PRINTR_CLAUDE_CLI",
                    "Claude CLI not found (\"{program}\"): install it or set PRINTR_CLAUDE_CLI", "Claude CLI niet gevonden (\"{program}\"): installeer ze of stel PRINTR_CLAUDE_CLI in"
                )
            ),
            _ => anyhow::anyhow!(
                "{}",
                tr!("impossible de lancer la CLI Claude : {e}", "could not start the Claude CLI: {e}", "kon de Claude CLI niet starten: {e}")
            ),
        })?;

        // Le prompt passe par l'entrée standard ; les sorties sont lues à part pour ne jamais bloquer.
        if let Some(mut stdin) = child.stdin.take() {
            stdin.write_all(prompt.as_bytes())?;
        }
        let reader = |pipe: Option<Box<dyn Read + Send>>| {
            std::thread::spawn(move || {
                let mut text = String::new();
                if let Some(mut pipe) = pipe {
                    let _ = pipe.read_to_string(&mut text);
                }
                text
            })
        };
        let stdout = reader(child.stdout.take().map(|s| Box::new(s) as _));
        let stderr = reader(child.stderr.take().map(|s| Box::new(s) as _));

        let start = Instant::now();
        let timeout = api_timeout();
        let status = loop {
            if let Some(status) = child.try_wait()? {
                break status;
            }
            if start.elapsed() > timeout {
                let _ = child.kill();
                let _ = child.wait();
                bail!("{}", t("la CLI Claude ne répond pas", "the Claude CLI is not responding", "de Claude CLI reageert niet"));
            }
            std::thread::sleep(Duration::from_millis(50));
        };
        let stdout = stdout.join().unwrap_or_default();
        let stderr = stderr.join().unwrap_or_default();

        let Ok(reply) = serde_json::from_str::<Value>(&stdout) else {
            let message = stderr.lines().chain(stdout.lines()).rfind(|l| !l.trim().is_empty());
            let message = message.unwrap_or(t("erreur inconnue", "unknown error", "onbekende fout"));
            bail!("{}", tr!("CLI Claude ({status}) : {message}", "Claude CLI ({status}): {message}", "Claude CLI ({status}): {message}"));
        };
        debug(&reply);
        if reply["is_error"].as_bool() == Some(true) || !status.success() {
            let message =
                reply["result"].as_str().or(reply["subtype"].as_str()).unwrap_or(t("erreur inconnue", "unknown error", "onbekende fout"));
            bail!("{}", tr!("CLI Claude : {message}", "Claude CLI: {message}", "Claude CLI: {message}"));
        }
        match reply.get("structured_output") {
            Some(value) if !value.is_null() => Ok(value.clone()),
            _ => {
                let text = reply["result"].as_str().unwrap_or_default();
                // Terugval: soms schrijft het model de JSON in de tekst, of de tool-aanroep als tekst.
                if let Some(value) = tool_call_in_text(text) {
                    return Ok(value);
                }
                if let (Some(a), Some(b)) = (text.find('{'), text.rfind('}'))
                    && let Some(json) = text.get(a..=b)
                    && let Ok(value) = serde_json::from_str::<Value>(json)
                {
                    return Ok(value);
                }
                serde_json::from_str(text)
                    .with_context(|| tr!("JSON inattendu de Claude : {text}", "unexpected JSON from Claude: {text}", "onverwachte JSON van Claude: {text}"))
            }
        }
    }
}

/// `<invoke name="StructuredOutput"><parameter name="k">v</parameter>…` als tekst teruggegeven:
/// de eerste aanroep als JSON-object (waarden die zelf JSON zijn, zoals lijsten, blijven JSON).
fn tool_call_in_text(text: &str) -> Option<Value> {
    let start = text.find("<invoke name=\"StructuredOutput\">")?;
    let call = &text[start..text[start..].find("</invoke>").map_or(text.len(), |e| start + e)];
    let mut object = serde_json::Map::new();
    for part in call.split("<parameter name=\"").skip(1) {
        let (name, rest) = part.split_once("\">")?;
        let value = rest.split("</parameter>").next()?.trim();
        let value = match value.chars().next() {
            Some('[' | '{') => serde_json::from_str(value).unwrap_or_else(|_| Value::String(value.to_owned())),
            _ => Value::String(value.to_owned()),
        };
        object.insert(name.to_owned(), value);
    }
    (!object.is_empty()).then_some(Value::Object(object))
}

fn api_agent() -> ureq::Agent {
    ureq::Agent::config_builder().timeout_global(Some(api_timeout())).http_status_as_error(false).build().into()
}

fn cli_program() -> String {
    std::env::var("PRINTR_CLAUDE_CLI").ok().filter(|c| !c.trim().is_empty()).unwrap_or_else(|| "claude".to_owned())
}

/// Programme trouvé dans le PATH, ou chemin existant.
fn installed(program: &str) -> bool {
    if program.contains('/') {
        return std::path::Path::new(program).is_file();
    }
    std::env::var_os("PATH").is_some_and(|path| std::env::split_paths(&path).any(|dir| dir.join(program).is_file()))
}

fn debug(reply: &Value) {
    if std::env::var_os("PRINTR_DEBUG").is_some() {
        eprintln!("[claude] {reply}");
    }
}

fn supports_default_fallbacks(model: &str) -> bool {
    ["claude-opus-5", "claude-fable-5", "claude-sonnet-5-5"].iter().any(|p| model.starts_with(p))
}

/// Message quand Claude n'est pas disponible (ni clé API, ni point de terminaison, ni CLI).
/// Extra instructie voor `PRINTR_LANG=nl`.
const DUTCH: &str = "IMPORTANT: write every JSON value in Dutch (Nederlands, natural for Flemish/Belgian \
                     readers), even if the JSON keys are French. Keep the JSON keys exactly as specified.";

pub fn missing() -> &'static str {
    t(
        "Claude indisponible : définis ANTHROPIC_API_KEY, pointe ANTHROPIC_BASE_URL vers un serveur compatible, ou installe la CLI Claude",
        "Claude unavailable: set ANTHROPIC_API_KEY, point ANTHROPIC_BASE_URL at a compatible server, or install the Claude CLI", "Claude niet beschikbaar: stel ANTHROPIC_API_KEY in, laat ANTHROPIC_BASE_URL naar een compatibele server wijzen, of installeer de Claude CLI",
    )
}

#[cfg(test)]
mod tool_text_tests {
    #[test]
    fn reads_tool_call_written_as_text() {
        let text = "\n<invoke name=\"StructuredOutput\">\n<parameter name=\"mot\">gedruis</parameter>\n\
                    <parameter name=\"lijst\">[1, 2]</parameter>\n</invoke>\n<invoke name=\"StructuredOutput\">\n</invoke>";
        let v = super::tool_call_in_text(text).unwrap();
        assert_eq!(v["mot"], "gedruis");
        assert_eq!(v["lijst"][1], 2);
        assert!(super::tool_call_in_text("{\"a\": 1}").is_none());
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn api_url_resolution() {
        assert_eq!(api_url_from(None), DEFAULT_API_URL);
        assert_eq!(api_url_from(Some("   ")), DEFAULT_API_URL);
        assert_eq!(api_url_from(Some("http://127.0.0.1:8000")), "http://127.0.0.1:8000/v1/messages");
        assert_eq!(api_url_from(Some("http://127.0.0.1:8000/")), "http://127.0.0.1:8000/v1/messages");
        assert_eq!(api_url_from(Some("http://127.0.0.1:8000/v1/messages")), "http://127.0.0.1:8000/v1/messages");
        assert_eq!(api_url_from(Some("http://127.0.0.1:8000/v1/messages/")), "http://127.0.0.1:8000/v1/messages");
        assert_eq!(api_url_from(Some("  https://api.anthropic.com/ ")), "https://api.anthropic.com/v1/messages");
    }

    #[test]
    fn api_timeout_resolution() {
        assert_eq!(timeout_from(None), DEFAULT_TIMEOUT);
        assert_eq!(timeout_from(Some("600")), Duration::from_secs(600));
        assert_eq!(timeout_from(Some("  45 ")), Duration::from_secs(45));
        // Zéro, vide ou illisible : le défaut est conservé (un délai de 0 s ferait échouer
        // chaque appel).
        assert_eq!(timeout_from(Some("0")), DEFAULT_TIMEOUT);
        assert_eq!(timeout_from(Some("")), DEFAULT_TIMEOUT);
        assert_eq!(timeout_from(Some("soon")), DEFAULT_TIMEOUT);
    }
}
