import test from "node:test";
import assert from "node:assert/strict";
import { createCipheriv } from "node:crypto";
import { SEAT_LAYOUT_KEY, decryptSeatLayout, parseSeatLayout } from "../src/providers/bms.ts";
import { matchesSeatSpec, jitter } from "../src/engine.ts";
import { toIstStamp } from "../src/time.ts";
import type { Seat } from "../src/types.ts";

function encrypt(plain: string): string {
  const cipher = createCipheriv("aes-256-cbc", Buffer.from(SEAT_LAYOUT_KEY, "utf8"), Buffer.alloc(16));
  return Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]).toString("base64");
}

test("BMS seat layout round-trips through AES-CBC and parses", () => {
  const layout =
    "GOLD:A:0000000003:1:N:0||" +
    "1:N:A000:A111+47:A200+12:A411+5";

  const plain = decryptSeatLayout(encrypt(layout));
  assert.equal(plain, layout);

  const seats = parseSeatLayout(plain);
  assert.equal(seats.length, 3, "gangway token is skipped");

  const byKey = new Map(seats.map((s) => [s.key, s]));
  assert.equal(byKey.get("N47")?.status, "available");
  assert.equal(byKey.get("N47")?.area, "GOLD");
  assert.equal(byKey.get("N12")?.status, "booked");
  assert.equal(byKey.get("N5")?.status, "available", "status 4 (best seat) counts as available");
});

test("BMS layout without the row separator returns no seats", () => {
  assert.deepEqual(parseSeatLayout("GOLD:A:0000000003:1:N:0"), []);
});

test("seat spec matches rows and exact seats, case-insensitively", () => {
  const seat = (key: string, row: string, number: string): Seat => ({
    key,
    area: "ELITE",
    row,
    number,
    status: "available",
  });

  const h12 = seat("H12", "H", "12");
  const j12 = seat("J12", "J", "12");

  assert.equal(matchesSeatSpec(h12, { rows: ["H"] }), true);
  assert.equal(matchesSeatSpec(j12, { rows: ["H"] }), false);
  assert.equal(matchesSeatSpec(h12, { seats: ["h-12"] }), true);
  assert.equal(matchesSeatSpec(j12, { seats: ["H12"] }), false);
  assert.equal(matchesSeatSpec(h12, {}), true, "empty spec watches everything");
});

test("jitter never drops below the 60 second floor", () => {
  for (let i = 0; i < 500; i++) {
    assert.ok(jitter(60, 80) >= 60);
    assert.ok(jitter(120, 25) >= 60);
  }
  assert.equal(jitter(1000, 0), 1000);
});

test("District showTime is UTC and rendered as IST", () => {
  assert.deepEqual(toIstStamp("2026-12-19T04:10"), { date: "2026-12-19", time: "09:40" });
  assert.deepEqual(toIstStamp("2026-12-19T03:45"), { date: "2026-12-19", time: "09:15" });
});
