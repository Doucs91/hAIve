import { describe, expect, it } from "vitest";
import { findSensorBlindSpots } from "../src/sensors.js";
import type { Sensor } from "../src/types.js";

const sensor = (over: Partial<Sensor> = {}): Sensor => ({
  kind: "regex",
  pattern: "MINIO_ROOT_PASSWORD:\\s*\\S",
  severity: "block",
  message: "No hardcoded credentials, even for development.",
  paths: ["frontend/src"],
  exclude: [],
  last_fired: null,
  ...(over as object),
}) as Sensor;

describe("findSensorBlindSpots", () => {
  it("names the file a too-narrow scope leaves unguarded (the docker-compose secret)", () => {
    const spots = findSensorBlindSpots(
      [{ id: "no-hardcoded-credentials", sensor: sensor(), anchorPaths: ["frontend/src"] }],
      [
        { path: "docker-compose.yml", content: "services:\n  minio:\n    environment:\n      MINIO_ROOT_PASSWORD: dev-password\n" },
        { path: "frontend/src/app.ts", content: "export const x = 1;\n" },
      ],
    );
    expect(spots).toHaveLength(1);
    expect(spots[0]!.memory_id).toBe("no-hardcoded-credentials");
    expect(spots[0]!.match_count).toBe(1);
    expect(spots[0]!.matches[0]!.path).toBe("docker-compose.yml");
  });

  it("says nothing when the sensor is repo-wide, so nothing is out of scope", () => {
    const spots = findSensorBlindSpots(
      [{ id: "s", sensor: sensor({ paths: [] }), anchorPaths: [] }],
      [{ path: "docker-compose.yml", content: "MINIO_ROOT_PASSWORD: dev\n" }],
    );
    expect(spots).toEqual([]);
  });

  it("does not report documentation, which a content sensor can never fire on via a scope", () => {
    const spots = findSensorBlindSpots(
      [{ id: "s", sensor: sensor(), anchorPaths: ["frontend/src"] }],
      [{ path: "docs/setup.md", content: "never write `MINIO_ROOT_PASSWORD: dev` in compose\n" }],
    );
    expect(spots).toEqual([]);
  });

  it("skips presence sensors and non-regex kinds", () => {
    const spots = findSensorBlindSpots(
      [
        { id: "presence", sensor: sensor({ require_present: true }), anchorPaths: [] },
        { id: "ast", sensor: sensor({ kind: "ast" }), anchorPaths: [] },
      ],
      [{ path: "docker-compose.yml", content: "MINIO_ROOT_PASSWORD: dev\n" }],
    );
    expect(spots).toEqual([]);
  });

  it("ranks a blind block sensor above a blind warn sensor", () => {
    const files = [{ path: "docker-compose.yml", content: "MINIO_ROOT_PASSWORD: dev\n" }];
    const spots = findSensorBlindSpots(
      [
        { id: "warn-one", sensor: sensor({ severity: "warn" }), anchorPaths: ["frontend/src"] },
        { id: "block-one", sensor: sensor({ severity: "block" }), anchorPaths: ["frontend/src"] },
      ],
      files,
    );
    expect(spots.map((s) => s.memory_id)).toEqual(["block-one", "warn-one"]);
  });
});
