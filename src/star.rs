//! Star-rasterprinters (TSP100 en verwanten, `PRINTR_PROTOCOL=star`): ze kennen geen ESC/POS-tekst,
//! dus Bonnetje tekent het ticket zelf en stuurt het als Star-raster.
//!
//! De opmaak volgt wat een Epson met dezelfde opdrachten zou printen (en wat de emupos-brug
//! vroeger tekende): fonts A 12×24 en B 9×17 (bitmapfonts Spleen/misc-fixed, licentie in de
//! bestanden), tekstzone van `doc::text_width()` punten gecentreerd, regelafstand 30 punten.
//! Het ticket wordt `paper_dots()` breed getekend en gecentreerd op de 576 punten van de kop.

use std::collections::HashMap;
use std::sync::OnceLock;

use anyhow::Result;
use image::{GrayImage, Luma, imageops};

use crate::doc::{Align, Doc, Op, Style};
use crate::raster::paper_dots;

/// Breedte van de printkop van een 80 mm-Star, in punten.
const HEAD_DOTS: u32 = 576;
/// Standaardregelafstand van ESC/POS (`ESC 2`), in punten.
const LINE_SPACING: u32 = 30;

const INK: Luma<u8> = Luma([0]);

/// Star-raster gevraagd met `PRINTR_PROTOCOL=star`?
pub fn enabled() -> bool {
    static ON: OnceLock<bool> = OnceLock::new();
    *ON.get_or_init(|| std::env::var("PRINTR_PROTOCOL").is_ok_and(|v| v.trim().eq_ignore_ascii_case("star")))
}

struct Font {
    width: u32,
    height: u32,
    glyphs: HashMap<char, Vec<u8>>,
}

fn parse_font(text: &str, width: u32, height: u32) -> Font {
    let glyphs = text
        .lines()
        .filter(|l| !l.is_empty() && !l.starts_with('#'))
        .filter_map(|l| {
            let (cp, rows) = l.split_once(char::is_whitespace)?;
            let c = char::from_u32(u32::from_str_radix(cp, 16).ok()?)?;
            let rows = rows.trim();
            let bytes = (0..rows.len()).step_by(2).filter_map(|i| u8::from_str_radix(rows.get(i..i + 2)?, 16).ok());
            Some((c, bytes.collect()))
        })
        .collect();
    Font { width, height, glyphs }
}

fn font(small: bool) -> &'static Font {
    static A: OnceLock<Font> = OnceLock::new();
    static B: OnceLock<Font> = OnceLock::new();
    if small {
        B.get_or_init(|| parse_font(include_str!("../assets/fonts/font-b-9x17.hex"), 9, 17))
    } else {
        A.get_or_init(|| parse_font(include_str!("../assets/fonts/font-a-12x24.hex"), 12, 24))
    }
}

/// Eén tekencel in de stijl van de regel (vet, vergroot, onderstreept, invers).
fn cell(c: char, style: &Style) -> GrayImage {
    let f = font(style.small);
    let (w, h) = (f.width, f.height);
    let mut img = GrayImage::from_pixel(w, h, Luma([255]));
    match f.glyphs.get(&c) {
        Some(rows) => {
            let stride = w.div_ceil(8) as usize;
            for y in 0..h {
                for x in 0..w {
                    let byte = rows.get(y as usize * stride + (x / 8) as usize).copied().unwrap_or(0);
                    if byte & (0x80 >> (x % 8)) != 0 {
                        img.put_pixel(x, y, INK);
                    }
                }
            }
        }
        // Onbekend teken: een kader met een diagonaal, zoals de emulator.
        None => {
            for x in 1..w - 1 {
                img.put_pixel(x, 1, INK);
                img.put_pixel(x, h - 2, INK);
            }
            for y in 1..h - 1 {
                img.put_pixel(1, y, INK);
                img.put_pixel(w - 2, y, INK);
                img.put_pixel(1 + (h - 2 - y) * (w - 3) / (h - 2), y, INK);
            }
        }
    }
    if style.bold {
        // Lijnen één punt breder: het teken over zichzelf, één punt naar rechts.
        let src = img.clone();
        for y in 0..h {
            for x in 1..w {
                if src.get_pixel(x - 1, y).0[0] == 0 {
                    img.put_pixel(x, y, INK);
                }
            }
        }
    }
    let n = u32::from(style.size.max(1));
    if n > 1 {
        img = imageops::resize(&img, w * n, h * n, imageops::FilterType::Nearest);
    }
    if style.underline {
        let y = img.height() - 1;
        for x in 0..img.width() {
            img.put_pixel(x, y, INK);
        }
    }
    if style.reverse {
        imageops::invert(&mut img);
    }
    img
}

fn left_edge(align: Align, width: u32, area: u32) -> u32 {
    let width = width.min(area);
    match align {
        Align::Left => 0,
        Align::Center => (area - width) / 2,
        Align::Right => area - width,
    }
}

/// Alleen inkt kopiëren (zoals een thermische kop: punten tellen op), afgekapt aan de rand.
fn paste_ink(dst: &mut GrayImage, src: &GrayImage, left: u32, top: u32) {
    for (x, y, p) in src.enumerate_pixels() {
        let (dx, dy) = (left + x, top + y);
        if p.0[0] < 128 && dx < dst.width() && dy < dst.height() {
            dst.put_pixel(dx, dy, INK);
        }
    }
}

fn line_strip(text: &str, style: &Style) -> GrayImage {
    let cells: Vec<GrayImage> = text.chars().map(|c| cell(c, style)).collect();
    let height = cells.iter().map(GrayImage::height).max().unwrap_or(font(style.small).height);
    let extent: u32 = cells.iter().map(GrayImage::width).sum();
    let paper = paper_dots();
    let area = crate::doc::text_width();
    let mut strip = GrayImage::from_pixel(paper, height, Luma([255]));
    let mut x = (paper - area) / 2 + left_edge(style.align, extent, area);
    for c in &cells {
        paste_ink(&mut strip, c, x, height - c.height());
        x += c.width();
    }
    if style.upside_down { imageops::rotate180(&strip) } else { strip }
}

fn qr_image(data: &str, module: u8) -> Option<GrayImage> {
    const QUIET: u32 = 4;
    let code = qrcode::QrCode::with_error_correction_level(data.as_bytes(), qrcode::EcLevel::M).ok()?;
    let modules = code.width() as u32;
    let m = u32::from(module.max(1));
    let size = (modules + 2 * QUIET) * m;
    let mut img = GrayImage::from_pixel(size, size, Luma([255]));
    for (i, color) in code.to_colors().iter().enumerate() {
        if *color == qrcode::Color::Dark {
            let (mx, my) = (i as u32 % modules, i as u32 / modules);
            for dy in 0..m {
                for dx in 0..m {
                    img.put_pixel((mx + QUIET) * m + dx, (my + QUIET) * m + dy, INK);
                }
            }
        }
    }
    Some(img)
}

/// Het ticket als beelden van `paper_dots()` breed: één per stuk tussen twee snedes.
/// Witte ruimte onderaan een stuk valt weg (zoals bij de emulator).
pub fn pages(doc: &Doc) -> Vec<GrayImage> {
    let paper = paper_dots();
    let mut pages = Vec::new();
    let mut strips: Vec<(u32, GrayImage)> = Vec::new();
    let mut y = 0;
    let flush = |strips: &mut Vec<(u32, GrayImage)>, y: &mut u32, pages: &mut Vec<GrayImage>| {
        let bottom = strips.iter().map(|(top, s)| top + s.height()).max().unwrap_or(0);
        if bottom > 0 {
            let mut page = GrayImage::from_pixel(paper, bottom, Luma([255]));
            for (top, s) in strips.iter() {
                paste_ink(&mut page, s, 0, *top);
            }
            pages.push(page);
        }
        strips.clear();
        *y = 0;
    };
    for op in &doc.ops {
        match op {
            Op::Line { text, style } => {
                let strip = line_strip(text, style);
                let h = strip.height();
                strips.push((y, strip));
                y += h.max(LINE_SPACING);
            }
            Op::Image(img) => {
                let mut strip = GrayImage::from_pixel(paper, img.height(), Luma([255]));
                paste_ink(&mut strip, img, (paper.saturating_sub(img.width())) / 2, 0);
                strips.push((y, strip));
                y += img.height();
            }
            Op::Qr { data, size } => {
                if let Some(img) = qr_image(data, *size) {
                    let mut strip = GrayImage::from_pixel(paper, img.height(), Luma([255]));
                    paste_ink(&mut strip, &img, (paper.saturating_sub(img.width())) / 2, 0);
                    strips.push((y, strip));
                    y += img.height();
                }
            }
            Op::Feed(n) => y += u32::from(*n) * LINE_SPACING,
            Op::Cut => flush(&mut strips, &mut y, &mut pages),
        }
    }
    flush(&mut strips, &mut y, &mut pages);
    pages
}

/// Star-rasteropdrachten voor een ticket: elk stuk wordt uitgeworpen en gesneden (`ESC FF NUL`).
/// Zonder `cut` blijft het laatste stuk staan tot het volgende ticket.
pub fn render(doc: &Doc, cut: bool) -> Result<Vec<u8>> {
    let pages = pages(doc);
    let last_cut = cut || doc.ends_with_cut();
    let mut out = b"\x1b@\x1b*rR\x1b*rA\x1b*rP0\x00".to_vec();
    for (i, page) in pages.iter().enumerate() {
        rows(&mut out, page);
        if i + 1 < pages.len() || last_cut {
            out.extend_from_slice(b"\x1b\x0c\x00");
        }
    }
    out.extend_from_slice(b"\x1b*rB");
    Ok(out)
}

/// Rasterrijen `b n1 n2 data` (1 = zwart), gecentreerd op de printkop.
fn rows(out: &mut Vec<u8>, page: &GrayImage) {
    let stride = (HEAD_DOTS / 8) as usize;
    let offset = HEAD_DOTS.saturating_sub(page.width()) / 2;
    for y in 0..page.height() {
        let mut row = vec![0u8; stride];
        for x in 0..page.width().min(HEAD_DOTS) {
            if page.get_pixel(x, y).0[0] < 128 {
                let dx = (x + offset) as usize;
                row[dx / 8] |= 0x80 >> (dx % 8);
            }
        }
        out.push(b'b');
        out.extend_from_slice(&(stride as u16).to_le_bytes());
        out.extend_from_slice(&row);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn count(hay: &[u8], needle: &[u8]) -> usize {
        hay.windows(needle.len()).filter(|w| *w == needle).count()
    }

    #[test]
    fn raster_framing_and_cuts() {
        let mut doc = Doc::new();
        doc.text("Hallo", Style::default().bold().center());
        doc.feed(1);
        doc.cut();
        doc.text("tweede stuk █░", Style::default().size(2).reverse());
        let bytes = render(&doc, true).unwrap();
        assert!(bytes.starts_with(b"\x1b@\x1b*rR\x1b*rA\x1b*rP0\x00"));
        assert!(bytes.ends_with(b"\x1b*rB"));
        assert_eq!(count(&bytes, b"\x1b\x0c\x00"), 2, "één snede per stuk");
        // Hallo (24) + tweede stuk (48 bij size 2): rijen van 72 bytes.
        assert_eq!(count(&bytes, &[b'b', 72, 0]) >= 24 + 48, true);
        let pages = pages(&doc);
        assert_eq!(pages.len(), 2);
        assert_eq!(pages[0].height(), 24, "witte voeding onderaan valt weg");
        assert_eq!(pages[1].height(), 48);
        // Geen snede gevraagd: het laatste stuk wordt niet uitgeworpen.
        assert_eq!(count(&render(&doc, false).unwrap(), b"\x1b\x0c\x00"), 1);
    }

    #[test]
    fn fonts_cover_text_and_blocks() {
        for c in "AZaz09éèëçàüÉ€█░▒▓─│".chars() {
            assert!(font(false).glyphs.contains_key(&c), "font A mist {c}");
        }
        // Een volle blok vult de hele cel: balkjes zonder gaten.
        let full = cell('█', &Style::default());
        assert!(full.pixels().all(|p| p.0[0] == 0));
    }
}
