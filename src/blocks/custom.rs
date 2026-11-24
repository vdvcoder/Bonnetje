//! Eigen blok (Bonnetje): een uitvoerbaar script in `PRINTR_BLOCKS_DIR` (standaard
//! `/opt/bonnetje/blokken`) dat gewone blokken als JSON teruggeeft. Zo wordt een nieuw idee één
//! script, in welke taal ook.
//!
//! Contract van een script `<map>/<naam>`:
//! - naam: kleine letters, cijfers, `-` en `_` (max. 40 tekens), uitvoerbaar;
//! - omgeving: `BONNETJE_LANG` (`nl`, `en`, `fr`), `BONNETJE_DATE` (`2026-11-24`) en `BONNETJE_CITY`
//!   (de stad uit de instellingen, bv. `Kortemark`);
//! - stdout: een JSON-lijst van blokken (`[{"type": "title", "text": "…"}, …]`) of
//!   `{"blocks": […]}`, met dezelfde bloktypes als een ticket (geen eigen blok erin);
//! - exitcode 0; anders wordt de laatste regel van stderr de foutmelding;
//! - klaar binnen `PRINTR_BLOCKS_TIMEOUT_SECS` seconden (standaard 180).

use std::io::Read;
use std::path::PathBuf;
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

use anyhow::{Context, Result, bail};
use chrono::NaiveDate;

use super::Block;
use crate::i18n;

pub fn dir() -> PathBuf {
    std::env::var("PRINTR_BLOCKS_DIR")
        .ok()
        .filter(|d| !d.trim().is_empty())
        .unwrap_or_else(|| "/opt/bonnetje/blokken".to_owned())
        .into()
}

fn valid(name: &str) -> bool {
    (1..=40).contains(&name.len())
        && name.bytes().all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-' || b == b'_')
}

/// Beschikbare eigen blokken: uitvoerbare bestanden met een geldige naam, alfabetisch.
pub fn list() -> Vec<String> {
    use std::os::unix::fs::PermissionsExt;
    let Ok(entries) = std::fs::read_dir(dir()) else { return Vec::new() };
    let mut names: Vec<String> = entries
        .flatten()
        .filter(|e| e.metadata().is_ok_and(|m| m.is_file() && m.permissions().mode() & 0o111 != 0))
        .filter_map(|e| e.file_name().into_string().ok())
        .filter(|n| valid(n))
        .collect();
    names.sort();
    names
}

/// Draait het script en leest de blokken die het teruggeeft.
pub fn blocks(name: &str, today: NaiveDate) -> Result<Vec<Block>> {
    check_name(name)?;
    run(&dir().join(name), name, today)
}

fn check_name(name: &str) -> Result<()> {
    if !valid(name) {
        bail!("{}", tr!("nom de bloc invalide : {name}", "invalid block name: {name}", "ongeldige bloknaam: {name}"));
    }
    Ok(())
}

fn run(path: &std::path::Path, name: &str, today: NaiveDate) -> Result<Vec<Block>> {
    let mut child = Command::new(path)
        .env("BONNETJE_LANG", i18n::lang().code())
        .env("BONNETJE_DATE", today.to_string())
        .env("BONNETJE_CITY", std::env::var("PRINTR_CITY").unwrap_or_default())
        .current_dir(dir())
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .with_context(|| tr!("impossible de lancer {}", "cannot start {}", "kan {} niet starten", path.display()))?;
    let _ = name;

    let read = |pipe: Option<Box<dyn Read + Send>>| {
        std::thread::spawn(move || {
            let mut text = String::new();
            if let Some(mut pipe) = pipe {
                let _ = pipe.read_to_string(&mut text);
            }
            text
        })
    };
    let stdout = read(child.stdout.take().map(|s| Box::new(s) as _));
    let stderr = read(child.stderr.take().map(|s| Box::new(s) as _));
    let timeout = Duration::from_secs(
        std::env::var("PRINTR_BLOCKS_TIMEOUT_SECS").ok().and_then(|v| v.trim().parse().ok()).unwrap_or(180),
    );
    let start = Instant::now();
    let status = loop {
        if let Some(status) = child.try_wait()? {
            break status;
        }
        if start.elapsed() > timeout {
            let _ = child.kill();
            let _ = child.wait();
            bail!("{}", tr!("{name} ne répond pas", "{name} is not responding", "{name} reageert niet"));
        }
        std::thread::sleep(Duration::from_millis(50));
    };
    let stdout = stdout.join().unwrap_or_default();
    let stderr = stderr.join().unwrap_or_default();
    if !status.success() {
        let message = stderr.lines().rfind(|l| !l.trim().is_empty()).unwrap_or("");
        bail!("{name} ({status}): {message}");
    }
    parse(&stdout).with_context(|| tr!("réponse de {name} illisible", "unreadable output from {name}", "onleesbare uitvoer van {name}"))
}

// ---- Beheren vanuit de app (alleen beheerders) ----

/// Code van een script; zonder shebang wordt het Python 3.
fn with_shebang(code: &str) -> String {
    let code = code.replace("\r\n", "\n");
    if code.starts_with("#!") { code } else { format!("#!/usr/bin/env python3\n{code}") }
}

pub fn read(name: &str) -> Result<String> {
    check_name(name)?;
    Ok(std::fs::read_to_string(dir().join(name))?)
}

pub fn save(name: &str, code: &str) -> Result<()> {
    use std::os::unix::fs::PermissionsExt;
    check_name(name)?;
    let path = dir().join(name);
    let tmp = dir().join(format!(".{name}.{}.tmp", std::process::id()));
    std::fs::write(&tmp, with_shebang(code))
        .with_context(|| tr!("impossible d'écrire dans {}", "cannot write to {}", "kan niet schrijven in {}", dir().display()))?;
    std::fs::set_permissions(&tmp, std::fs::Permissions::from_mode(0o775))?;
    std::fs::rename(&tmp, &path)?;
    Ok(())
}

pub fn delete(name: &str) -> Result<()> {
    check_name(name)?;
    Ok(std::fs::remove_file(dir().join(name))?)
}

/// Draait nog niet bewaarde code (voorbeeld in de app) vanuit een tijdelijk bestand.
pub fn try_code(code: &str, today: NaiveDate) -> Result<Vec<Block>> {
    use std::os::unix::fs::PermissionsExt;
    let path = std::env::temp_dir().join(format!("bonnetje-blok-{}-{}", std::process::id(), rand::random::<u32>()));
    std::fs::write(&path, with_shebang(code))?;
    std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o700))?;
    let result = run(&path, "voorbeeld", today);
    let _ = std::fs::remove_file(&path);
    result
}

#[derive(serde::Deserialize, serde::Serialize)]
pub struct Generated {
    pub code: String,
    pub uitleg: String,
}

/// Laat Claude een script schrijven (of een bestaand bijsturen) uit een beschrijving.
pub fn generate(claude: &crate::claude::Claude, description: &str, code: Option<&str>, feedback: Option<&str>) -> Result<Generated> {
    let mut prompt = format!("Wat het blok moet doen:\n{description}\n");
    if let Some(code) = code.filter(|c| !c.trim().is_empty()) {
        prompt.push_str(&format!("\nHuidige code:\n{code}\n"));
    }
    if let Some(feedback) = feedback.filter(|f| !f.trim().is_empty()) {
        prompt.push_str(&format!("\nPas het aan:\n{feedback}\n"));
    }
    let schema = serde_json::json!({
        "type": "object", "additionalProperties": false, "required": ["code", "uitleg"],
        "properties": { "code": { "type": "string" }, "uitleg": { "type": "string" } }
    });
    claude.generate(GENERATE_SYSTEM, &prompt, schema, "medium")
}

const GENERATE_SYSTEM: &str = r#"You write "custom block" scripts for Bonnetje, a receipt-printer app (80 mm thermal printer,
42 characters per line in the normal font, 56 in the small font). Write the script in Python 3 using only the standard
library (urllib for web requests; no pip packages). It runs on a Raspberry Pi as an unprivileged user without access to
/home, with environment variables BONNETJE_LANG (e.g. "nl"), BONNETJE_DATE (YYYY-MM-DD, the day being printed) and
BONNETJE_CITY (the user's home town from the settings, e.g. "Kortemark"; use it whenever a place is needed and the idea does
not name one: never invent a city; for coordinates use the free geocoding API of open-meteo). It must
finish within 3 minutes, print ONLY a JSON list of blocks on stdout (json.dumps(blocks, ensure_ascii=False)), and exit 0.
On errors, print a short message to stderr and exit 1. Text on the receipt is in Dutch unless asked otherwise.

Available block types (JSON objects with "type"):
- {"type": "title", "text": "...", "size": 2}                       big centered title (size 1-3)
- {"type": "text", "text": "...", "bold": false, "underline": false, "reverse": false, "small": false, "size": 1,
   "align": "left"|"center"|"right"}                                 paragraph; "
" starts a new line; a line that fits
                                                                    the width keeps its spaces, so aligned columns work
- {"type": "separator", "style": "-"}                                full-width line ("-", "=", "*", "~", "·")
- {"type": "feed", "lines": 1}                                       blank lines
- {"type": "qr", "data": "https://...", "size": 4, "caption": "..."} QR code
- {"type": "date"}                                                   today's date as a heading
- {"type": "todo", "title": "...", "items": ["...", "..."]}         checklist with boxes
- {"type": "image", "url": "https://...png"}                         picture (dithered to black and white)
- {"type": "weather", "days": 3}                                    weather forecast for BONNETJE_CITY ("location" for another place)
- {"type": "quote"}, {"type": "word_of_the_day"}, {"type": "sudoku", "difficulty": "facile"|"moyen"|"difficile"}
Blocks are printed one after another without extra spacing: use separator/feed for layout.
Avoid emoji and characters outside Latin-1 (the printer cannot print them); use plain text, bold and reverse for emphasis.
Make the layout look good on a narrow receipt: a title, short lines, aligned columns when showing figures.

Return "code" (the complete script, starting with #!/usr/bin/env python3) and "uitleg" (one or two sentences in Dutch
explaining what the block does and any assumption you made)."#;

fn parse(json: &str) -> Result<Vec<Block>> {
    #[derive(serde::Deserialize)]
    #[serde(untagged)]
    enum Output {
        List(Vec<Block>),
        Ticket { blocks: Vec<Block> },
    }
    let blocks = match serde_json::from_str(json)? {
        Output::List(b) | Output::Ticket { blocks: b } => b,
    };
    if blocks.iter().any(|b| matches!(b, Block::Custom { .. })) {
        bail!("{}", i18n::t("pas de bloc perso dans un bloc perso", "no custom block inside a custom block", "geen eigen blok in een eigen blok"));
    }
    Ok(blocks)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn names_and_output() {
        assert!(valid("healthstatus") && valid("weer-2") && !valid("../x") && !valid("Hoi") && !valid(""));
        assert_eq!(parse(r#"[{"type": "title", "text": "Hallo"}]"#).unwrap().len(), 1);
        assert_eq!(parse(r#"{"cut": true, "blocks": [{"type": "separator"}]}"#).unwrap().len(), 1);
        assert!(parse(r#"[{"type": "custom", "name": "x"}]"#).is_err());
        assert!(parse("geen json").is_err());
    }

    #[test]
    fn runs_a_script() {
        use std::os::unix::fs::PermissionsExt;
        let dir = std::env::temp_dir().join(format!("bonnetje-blokken-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let script = dir.join("hallo");
        std::fs::write(&script, "#!/bin/sh\necho \"[{\\\"type\\\": \\\"title\\\", \\\"text\\\": \\\"$BONNETJE_DATE\\\"}]\"\n").unwrap();
        std::fs::set_permissions(&script, std::fs::Permissions::from_mode(0o755)).unwrap();
        std::fs::write(dir.join("kapot"), "#!/bin/sh\necho oeps >&2\nexit 3\n").unwrap();
        std::fs::set_permissions(dir.join("kapot"), std::fs::Permissions::from_mode(0o755)).unwrap();
        // SAFETY: test zet de map voor dit proces; andere tests lezen PRINTR_BLOCKS_DIR niet.
        unsafe { std::env::set_var("PRINTR_BLOCKS_DIR", &dir) };
        assert_eq!(list(), vec!["hallo", "kapot"]);
        let day = NaiveDate::from_ymd_opt(2026, 11, 24).unwrap();
        match &blocks("hallo", day).unwrap()[0] {
            Block::Title { text, .. } => assert_eq!(text, "2026-11-24"),
            other => panic!("{other:?}"),
        }
        assert!(format!("{:#}", blocks("kapot", day).unwrap_err()).contains("oeps"));
        let _ = std::fs::remove_dir_all(&dir);
    }
}
