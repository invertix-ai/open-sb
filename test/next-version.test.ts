import assert from "node:assert/strict";
import { test } from "node:test";
import { nextVersion } from "../scripts/next-version.ts";

test("first publish uses package.json", () => {
  assert.equal(nextVersion("0.1.0", []), "0.1.0");
});

test("already published: next patch after the highest", () => {
  assert.equal(nextVersion("0.1.0", ["0.1.0"]), "0.1.1");
  assert.equal(nextVersion("0.1.0", ["0.1.0", "0.1.7", "0.1.3"]), "0.1.8");
});

test("a hand bump above npm wins", () => {
  assert.equal(nextVersion("0.2.0", ["0.1.0", "0.1.7"]), "0.2.0");
});

test("prereleases on npm are ignored", () => {
  assert.equal(nextVersion("0.1.0", ["0.1.0", "0.2.0-beta.1"]), "0.1.1");
  assert.equal(nextVersion("0.1.0", ["1.0.0-rc.1"]), "0.1.0");
});

test("a non-plain package.json version is refused", () => {
  assert.throws(() => nextVersion("0.2.0-beta.1", []), /MAJOR.MINOR.PATCH/);
});
