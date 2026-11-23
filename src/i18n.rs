//! Langue de l'installation : `PRINTR_LANG=en` passe l'interface, les messages et les tickets en
//! anglais, `PRINTR_LANG=nl` en néerlandais (Bonnetje) ; le français reste la langue par défaut.
//!
//! Les traductions sont écrites à côté du texte français, là où il sert :
//! `t("Bonjour", "Hello", "Hallo")` pour une chaîne fixe, `tr!("{n} blocs", "{n} blocks", "{n} blokken")` pour une chaîne
//! formatée. Pas de catalogue à part : une phrase et sa traduction ne peuvent pas se perdre de vue.

use std::cell::Cell;
use std::sync::OnceLock;

use chrono::{Datelike, NaiveDate};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Lang {
    Fr,
    En,
    Nl,
}

impl Lang {
    fn parse(value: &str) -> Option<Lang> {
        match value.trim().to_ascii_lowercase().get(..2)? {
            "fr" => Some(Lang::Fr),
            "en" => Some(Lang::En),
            "nl" => Some(Lang::Nl),
            _ => None,
        }
    }

    /// Code BCP 47, pour `<html lang>` et les en-têtes HTTP.
    pub fn code(self) -> &'static str {
        match self {
            Lang::Fr => "fr",
            Lang::En => "en",
            Lang::Nl => "nl",
        }
    }
}

static LANG: OnceLock<Lang> = OnceLock::new();

thread_local! {
    /// Langue imposée au fil courant (tests, rendu des exemples dans les deux langues).
    static FORCED: Cell<Option<Lang>> = const { Cell::new(None) };
}

/// Langue en vigueur : `PRINTR_LANG` (« en », « en_US.UTF-8 »…), français sinon.
pub fn lang() -> Lang {
    FORCED.get().unwrap_or_else(|| *LANG.get_or_init(from_env))
}

#[cfg(not(test))]
fn from_env() -> Lang {
    std::env::var("PRINTR_LANG").ok().as_deref().and_then(Lang::parse).unwrap_or(Lang::Fr)
}

/// Les tests ne dépendent pas de l'environnement : français par défaut, `with_lang` pour l'anglais.
#[cfg(test)]
fn from_env() -> Lang {
    Lang::Fr
}

pub fn en() -> bool {
    lang() == Lang::En
}

pub fn nl() -> bool {
    lang() == Lang::Nl
}

/// Exécute `f` dans la langue donnée, sur ce fil seulement.
pub fn with_lang<T>(lang: Lang, f: impl FnOnce() -> T) -> T {
    let before = FORCED.replace(Some(lang));
    let out = f();
    FORCED.set(before);
    out
}

/// La chaîne de la langue en vigueur.
pub fn t(fr: &'static str, en: &'static str, nl: &'static str) -> &'static str {
    match lang() {
        Lang::Fr => fr,
        Lang::En => en,
        Lang::Nl => nl,
    }
}

/// `format!` dans la langue en vigueur : `tr!("{n} blocs", "{n} blocks", "{n} blokken")`.
#[macro_export]
macro_rules! tr {
    ($fr:literal, $en:literal, $nl:literal $(,)?) => {
        match $crate::i18n::lang() {
            $crate::i18n::Lang::Fr => format!($fr),
            $crate::i18n::Lang::En => format!($en),
            $crate::i18n::Lang::Nl => format!($nl),
        }
    };
    ($fr:literal, $en:literal, $nl:literal, $($arg:tt)+) => {
        match $crate::i18n::lang() {
            $crate::i18n::Lang::Fr => format!($fr, $($arg)+),
            $crate::i18n::Lang::En => format!($en, $($arg)+),
            $crate::i18n::Lang::Nl => format!($nl, $($arg)+),
        }
    };
}

#[rustfmt::skip]
const DAYS: [&str; 7] = ["lundi", "mardi", "mercredi", "jeudi", "vendredi", "samedi", "dimanche"];
#[rustfmt::skip]
const MONTHS: [&str; 12] = [
    "janvier", "février", "mars", "avril", "mai", "juin", "juillet", "août", "septembre", "octobre",
    "novembre", "décembre",
];
#[rustfmt::skip]
const DAYS_NL: [&str; 7] = ["maandag", "dinsdag", "woensdag", "donderdag", "vrijdag", "zaterdag", "zondag"];
#[rustfmt::skip]
const MONTHS_NL: [&str; 12] = [
    "januari", "februari", "maart", "april", "mei", "juni", "juli", "augustus", "september", "oktober",
    "november", "december",
];
#[rustfmt::skip]
const DAYS_EN: [&str; 7] = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"];
#[rustfmt::skip]
const MONTHS_EN: [&str; 12] = [
    "January", "February", "March", "April", "May", "June", "July", "August", "September", "October",
    "November", "December",
];

/// « mercredi », « Wednesday ».
pub fn weekday(date: NaiveDate) -> &'static str {
    let i = date.weekday().num_days_from_monday() as usize;
    t(DAYS[i], DAYS_EN[i], DAYS_NL[i])
}

/// « mer. », « Wed ».
pub fn weekday_short(date: NaiveDate) -> String {
    let day = weekday(date);
    match lang() {
        Lang::En => day[..3].to_owned(),
        Lang::Nl => day[..2].to_owned(),
        Lang::Fr => format!("{}.", &day[..3]),
    }
}

/// « octobre », « October ».
pub fn month(month0: u32) -> &'static str {
    t(MONTHS[month0 as usize], MONTHS_EN[month0 as usize], MONTHS_NL[month0 as usize])
}

pub fn capitalize(s: &str) -> String {
    let mut chars = s.chars();
    match chars.next() {
        Some(c) => c.to_uppercase().chain(chars).collect(),
        None => String::new(),
    }
}

/// « 1er octobre », « 7 octobre » ; « October 1 », « October 7 ».
pub fn day_month(date: NaiveDate) -> String {
    let name = month(date.month0());
    match (lang(), date.day()) {
        (Lang::En, d) => format!("{name} {d}"),
        (Lang::Fr, 1) => format!("1er {name}"),
        (_, d) => format!("{d} {name}"),
    }
}

/// « mardi 7 octobre 2026 », « Tuesday, October 7, 2026 ».
pub fn long_date(date: NaiveDate) -> String {
    if en() {
        format!("{}, {}, {}", weekday(date), day_month(date), date.year())
    } else {
        format!("{} {} {}", weekday(date), day_month(date), date.year())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn formats() {
        let d = NaiveDate::from_ymd_opt(2026, 10, 7).unwrap();
        with_lang(Lang::Fr, || {
            assert_eq!(long_date(d), "mercredi 7 octobre 2026");
            assert_eq!(weekday_short(d), "mer.");
            let d = NaiveDate::from_ymd_opt(2026, 8, 1).unwrap();
            assert_eq!(capitalize(&long_date(d)), "Samedi 1er août 2026");
        });
        with_lang(Lang::En, || {
            assert_eq!(long_date(d), "Wednesday, October 7, 2026");
            assert_eq!(weekday_short(d), "Wed");
        });
        with_lang(Lang::Nl, || {
            assert_eq!(long_date(d), "woensdag 7 oktober 2026");
            assert_eq!(weekday_short(d), "wo");
            assert_eq!(day_month(NaiveDate::from_ymd_opt(2026, 8, 1).unwrap()), "1 augustus");
            assert_eq!(tr!("{} blocs", "{} blocks", "{} blokken", 3), "3 blocks");
        });
    }

    #[test]
    fn parses_locales() {
        assert_eq!(Lang::parse("en_US.UTF-8"), Some(Lang::En));
        assert_eq!(Lang::parse("FR"), Some(Lang::Fr));
        assert_eq!(Lang::parse("nl_BE.UTF-8"), Some(Lang::Nl));
        assert_eq!(Lang::parse("de"), None);
    }
}
