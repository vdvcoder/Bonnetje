//! Planificateur : imprime les presets à l'heure prévue.
//!
//! Une échéance manquée de plus de `GRACE` (Pi éteint, imprimante débranchée…) n'est pas
//! rattrapée : un horoscope du matin ne doit pas sortir l'après-midi.

use std::sync::Arc;
use std::time::Duration as StdDuration;

use chrono::{Duration, Local, Utc};

use crate::blocks::Ticket;
use crate::server::App;

const GRACE: Duration = Duration::minutes(15);
const TICK: StdDuration = StdDuration::from_secs(20);

pub fn spawn(app: Arc<App>) {
    std::thread::spawn(move || {
        loop {
            run_due(&app);
            std::thread::sleep(TICK);
        }
    });
}

fn run_due(app: &App) {
    let now = Local::now();
    // Repère les échéances et les marque comme faites avant d'imprimer : un ticket lent
    // à construire ne doit jamais partir deux fois.
    let due: Vec<(String, serde_json::Value)> = {
        let mut store = app.lock_store();
        let mut due = Vec::new();
        for preset in &mut store.data.presets {
            for schedule in &mut preset.schedules {
                if schedule.due(now, GRACE).is_some() {
                    schedule.last_run = Some(Utc::now());
                    due.push((preset.name.clone(), preset.ticket.clone()));
                }
            }
        }
        if !due.is_empty()
            && let Err(e) = store.save()
        {
            eprintln!("{}", tr!("planification non enregistrée : {e:#}", "schedule not saved: {e:#}", "planning niet opgeslagen: {e:#}"));
        }
        due
    };

    for (name, ticket) in due {
        match serde_json::from_value::<Ticket>(ticket) {
            Ok(ticket) => {
                let printed = app.print(&ticket, "planification", &name);
                match printed.failure {
                    None if printed.queued.is_some() => eprintln!(
                        "{}",
                        tr!(
                            "planification « {name} » en attente de l'imprimante",
                            "schedule \"{name}\" waiting for the printer", "planning \"{name}\" wacht op de printer"
                        )
                    ),
                    None => eprintln!("{}", tr!("planification « {name} » imprimée", "schedule \"{name}\" printed", "planning \"{name}\" afgedrukt")),
                    Some(e) => eprintln!(
                        "{}",
                        tr!("planification « {name} » en échec : {e}", "schedule \"{name}\" failed: {e}", "planning \"{name}\" mislukt: {e}")
                    ),
                }
            }
            Err(e) => eprintln!(
                "{}",
                tr!("planification « {name} » : ticket invalide ({e})", "schedule \"{name}\": invalid ticket ({e})", "planning \"{name}\": ongeldig ticket ({e})")
            ),
        }
    }
}
