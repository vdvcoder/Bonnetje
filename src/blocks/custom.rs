//! Eigen blok (Bonnetje): een uitvoerbaar script in `PRINTR_BLOCKS_DIR` (standaard
//! `/opt/bonnetje/blokken`) dat gewone blokken als JSON teruggeeft. Zo wordt een nieuw idee één
//! script, in welke taal ook.
//!
//! Contract van een script `<map>/<naam>`:
//! - naam: kleine letters, cijfers, `-` en `_` (max. 40 tekens), uitvoerbaar;
//! - omgeving: `BONNETJE_LANG` (`nl`, `en`, `fr`) en `BONNETJE_DATE` (`2026-11-24`);
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
    if !valid(name) {
        bail!("{}", tr!("nom de bloc invalide : {name}", "invalid block name: {name}", "ongeldige bloknaam: {name}"));
    }
    let path = dir().join(name);
    let mut child = Command::new(&path)
        .env("BONNETJE_LANG", i18n::lang().code())
        .env("BONNETJE_DATE", today.to_string())
        .current_dir(dir())
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .with_context(|| tr!("impossible de lancer {}", "cannot start {}", "kan {} niet starten", path.display()))?;

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
