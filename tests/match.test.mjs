// Ausführen: node tests/match.test.mjs
import assert from "node:assert/strict";
import {
  cleanTitle, parseImportText, scoreCandidate, findDuplicates, planReorder, planRemoval, spreadShuffle, normalize,
} from "../js/match.js";

let n = 0;
const test = (name, fn) => { fn(); n++; console.log("✓", name); };

test("cleanTitle entfernt Versionszusätze", () => {
  assert.equal(cleanTitle("Wonderwall - 2011 Remaster"), "Wonderwall");
  assert.equal(cleanTitle("Imagine - Remastered 2010"), "Imagine");
  assert.equal(cleanTitle("Song (feat. Someone)"), "Song");
  assert.equal(cleanTitle("Insomnia - Radio Edit"), "Insomnia");
  assert.equal(cleanTitle("99 Luftballons"), "99 Luftballons");
  assert.equal(cleanTitle("21 Guns"), "21 Guns");
  assert.equal(cleanTitle("Part 2 - The Return"), "Part 2 - The Return");
});

test("parseImportText: Text mit Nummern und Spotify-Links", () => {
  const r = parseImportText("1. Faithless - Insomnia\n02) Robert Miles – Children\nhttps://open.spotify.com/track/4uLU6hMCjMI75M1A2tKUQC?si=x\n# Kommentar\n99 Luftballons");
  assert.equal(r.length, 4);
  assert.deepEqual([r[0].artist, r[0].title], ["Faithless", "Insomnia"]);
  assert.deepEqual([r[1].artist, r[1].title], ["Robert Miles", "Children"]);
  assert.equal(r[2].uri, "spotify:track:4uLU6hMCjMI75M1A2tKUQC");
  assert.equal(r[3].title, "99 Luftballons");
});

test("parseImportText: eigener CSV-Export", () => {
  const csv = "Position;Titel;Kuenstler;BPM;Jahr;Dauer;Spotify_URI\n1;Insomnia;Faithless;127;1995;3:35;spotify:track:4uLU6hMCjMI75M1A2tKUQC\n2;\"Children; Dream\";Robert Miles;137;1995;4:00;";
  const r = parseImportText(csv);
  assert.equal(r.length, 2);
  assert.equal(r[0].uri, "spotify:track:4uLU6hMCjMI75M1A2tKUQC");
  assert.equal(r[1].title, "Children; Dream");
  assert.equal(r[1].artist, "Robert Miles");
});

test("scoreCandidate bevorzugt Original vor Live/Karaoke", () => {
  const e = { artist: "Faithless", title: "Insomnia" };
  const orig = { name: "Insomnia", artist: "Faithless", artists: ["Faithless"], playable: true };
  const live = { name: "Insomnia - Live at Alexandra Palace", artist: "Faithless", artists: ["Faithless"], playable: true };
  const kara = { name: "Insomnia (Karaoke Version)", artist: "Karaoke Hits", artists: ["Karaoke Hits"], playable: true };
  assert.ok(scoreCandidate(e, orig) >= 90);
  assert.equal(scoreCandidate(e, live), 0);
  assert.ok(scoreCandidate(e, kara) < 40);
});

test("findDuplicates: URI, ISRC, Text+Dauer", () => {
  const t = [
    { uri: "a", name: "X", artist: "A", isrc: "I1", durationMs: 200000 },
    { uri: "b", name: "Y", artist: "B", durationMs: 180000 },
    { uri: "a", name: "X", artist: "A", isrc: "I1", durationMs: 200000 },
    { uri: "c", name: "X - 2011 Remaster", artist: "A", isrc: "I1", durationMs: 201000 },
    { uri: "d", name: "Y", artist: "B", durationMs: 400000 }, // Extended -> kein Duplikat
    { uri: "e", name: "Y", artist: "B", durationMs: 181000 },
  ];
  assert.deepEqual(findDuplicates(t), [2, 3, 5]);
});

test("planReorder erzeugt korrekte Zielreihenfolge", () => {
  for (let run = 0; run < 200; run++) {
    const items = Array.from({ length: 1 + Math.floor(Math.random() * 40) }, (_, i) => ({ i }));
    const target = items.slice().sort(() => Math.random() - 0.5);
    const ops = planReorder(items, target);
    const sim = items.slice();
    for (const op of ops) {
      // Spotify-Semantik: Element an range_start vor insert_before einfügen (insert_before < range_start)
      assert.ok(op.insertBefore < op.rangeStart);
      const [x] = sim.splice(op.rangeStart, 1);
      sim.splice(op.insertBefore, 0, x);
    }
    assert.deepEqual(sim, target);
    assert.ok(ops.length <= items.length);
  }
});

test("planRemoval behält nicht markierte Duplikate", () => {
  const t = ["a", "b", "a", "c", "a"].map((uri) => ({ uri }));
  const p = planRemoval(t, [2]); // nur das mittlere "a" löschen
  assert.deepEqual(p.uris, ["a"]);
  assert.deepEqual(p.finalList.map((x) => x.uri), ["a", "b", "c", "a"]);
  assert.deepEqual(p.reinserts, [{ uri: "a", position: 0 }, { uri: "a", position: 3 }]);
  // Simulation: alle "a" löschen, dann aufsteigend einfügen
  const sim = t.filter((x) => x.uri !== "a").map((x) => x.uri);
  for (const r of p.reinserts) sim.splice(r.position, 0, r.uri);
  assert.deepEqual(sim, ["a", "b", "c", "a"]);
});

test("spreadShuffle vermeidet gleiche Interpreten nebeneinander", () => {
  const t = [];
  for (let i = 0; i < 30; i++) t.push({ artist: ["A", "B", "C"][i % 3], name: "s" + i });
  for (let run = 0; run < 50; run++) {
    const s = spreadShuffle(t);
    assert.equal(s.length, t.length);
    for (let i = 1; i < s.length; i++) assert.notEqual(normalize(s[i].artist), normalize(s[i - 1].artist));
  }
});

console.log(`\n${n} Tests bestanden.`);
