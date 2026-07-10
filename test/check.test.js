import assert from "node:assert/strict";
import test from "node:test";
import { classifyMoodProduct, extractMeasurements, hasPreferredShopifySize } from "../src/check.js";

const fit = {
  tops: {
    targetChestIn: 40,
    minChestIn: 40,
    idealMaxChestIn: 47,
    absoluteMaxChestIn: 52,
    preferredLabelSizes: ["M", "L"],
    preferredEuSize: 50,
    minEuSize: 50,
    avoidTerms: ["skinny", "slim fit", "very slim", "tight"],
    preferTerms: ["oversized", "boxy", "relaxed", "wide", "80s", "90s"]
  },
  bottoms: {
    targetWaistIn: 35,
    minWaistIn: 34,
    idealMaxWaistIn: 38,
    absoluteMaxWaistIn: 40,
    targetInseamIn: 32,
    minInseamIn: 29,
    maxInseamIn: 34,
    avoidTerms: ["skinny", "slim fit", "very slim", "tight"],
    preferTerms: ["wide", "straight", "relaxed", "baggy", "tapered"]
  },
  shoes: {
    targetUk: 10.5,
    minUk: 10,
    maxUk: 11,
    preferredTerms: ["shoe", "shoes", "sneaker", "sneakers", "loafer", "loafers", "boot", "boots", "derby", "footwear"]
  }
};

test("parses Mood Body Width as flat chest width", () => {
  const measurements = extractMeasurements(`
    Body Length: 79 cm
    Body Width: 55 cm
    Sleeve Length: 53 cm
    Shoulder Width: 45 cm
  `);

  assert.equal(Math.round(measurements.pitToPitIn * 10) / 10, 21.7);
  assert.equal(Math.round(measurements.shoulderIn * 10) / 10, 17.7);
  assert.equal(Math.round(measurements.lengthIn * 10) / 10, 31.1);
});

test("classifies the Celine shirt sample from Body Width", () => {
  const result = classifyMoodProduct({
    title: "CÉLINE/ Beautiful Colored Logo Embroidered Cotton Shirt Blue",
    vendor: "CELINE",
    body_html: "A regular-collar shirt in a rich blue.",
    pageHtml: `
      <div class="attribute-item">
        <span class="attribute-label">Body Length:</span>
        <span class="attribute-value">79 cm</span>
      </div>
      <div class="attribute-item">
        <span class="attribute-label">Body Width:</span>
        <span class="attribute-value">55 cm</span>
      </div>
      <div class="attribute-item">
        <span class="attribute-label">Sleeve Length:</span>
        <span class="attribute-value">53 cm</span>
      </div>
      <div class="attribute-item">
        <span class="attribute-label">Shoulder Width:</span>
        <span class="attribute-value">45 cm</span>
      </div>
    `
  }, fit);

  assert.equal(result.status, "strong_match");
  assert.match(result.reason, /43\.3 in/);
});

test("downgrades roomy tops with smaller IT/EU label sizes to maybe", () => {
  const result = classifyMoodProduct({
    title: "\"WEEKEND Max Mara\" 10's Soft suede goat leather robe coat",
    vendor: "Max Mara",
    body_html: "The size is listed using international sizing, including IT 48. The body width is given ample ease.",
    pageHtml: `
      <div class="attribute-item">
        <span class="attribute-label">Body Length:</span>
        <span class="attribute-value">96 cm</span>
      </div>
      <div class="attribute-item">
        <span class="attribute-label">Body Width:</span>
        <span class="attribute-value">53 cm</span>
      </div>
      <div class="attribute-item">
        <span class="attribute-label">Shoulder Width:</span>
        <span class="attribute-value">47 cm</span>
      </div>
    `
  }, fit);

  assert.equal(result.status, "maybe_match");
  assert.match(result.reason, /IT\/EU 48/);
  assert.match(result.reason, /preferred 50/);
});

test("parses JS Archive inch-mark measurements", () => {
  const result = classifyMoodProduct({
    title: "MEN'S NYLON BLAZER",
    vendor: "J.S. Archive",
    body_html: "Marked as German 50 (L), please refer to measurements below. MEASUREMENTS Shoulder to Shoulder 19.5&quot; / Pit to Pit 22&quot; / Length at Back 29.5&quot;"
  }, fit);

  assert.equal(result.status, "strong_match");
  assert.equal(result.measurements.pitToPitIn, 22);
  assert.match(result.reason, /44 in/);
});

test("parses Mood Waist labels from rendered attributes", () => {
  const result = classifyMoodProduct({
    title: "Example wide trousers",
    vendor: "MOOD",
    body_html: "Straight trousers.",
    pageHtml: `
      <div class="attribute-item">
        <span class="attribute-label">Waist:</span>
        <span class="attribute-value">54 cm</span>
      </div>
      <div class="attribute-item">
        <span class="attribute-label">Rise:</span>
        <span class="attribute-value">31 cm</span>
      </div>
      <div class="attribute-item">
        <span class="attribute-label">Inseam:</span>
        <span class="attribute-value">72 cm</span>
      </div>
    `
  }, fit);

  assert.equal(Math.round(result.measurements.waistIn * 10) / 10, 21.3);
  assert.equal(result.status, "too_small");
  assert.match(result.reason, /21\.3 in/);
});

test("parses Bluehorse metric measurements without explicit units", () => {
  const result = classifyMoodProduct({
    title: "1980s Gianni Versace Bermuda shorts white",
    vendor: "Versace",
    body_html: "Pants Size: 52 Waist: 95 inside seam: 81 *All measurements are taken in metric"
  }, fit);

  assert.equal(result.status, "strong_match");
  assert.equal(Math.round(result.measurements.waistIn * 10) / 10, 37.4);
  assert.equal(Math.round(result.measurements.inseamIn * 10) / 10, 31.9);
});

test("ignores skirts instead of surfacing them as bottom candidates", () => {
  const result = classifyMoodProduct({
    title: "LOEWE Fringe Designed Beige Anagram Blanket Skirt",
    vendor: "MOOD",
    body_html: "",
    pageHtml: `
      <div class="attribute-item">
        <span class="attribute-label">Waist:</span>
        <span class="attribute-value">54 cm</span>
      </div>
    `
  }, fit);

  assert.equal(result.status, "ignored");
});

test("ignores bags, scarves, and ties", () => {
  for (const title of [
    "CELINE Classic black leather shoulder bag",
    "Christian Dior Classic printed scarf",
    "Example Brand Navy Yellow Striped Silk Bow Tie"
  ]) {
    const result = classifyMoodProduct({
      title,
      vendor: "MOOD",
      body_html: "Shoulder width: 45 cm"
    }, fit);

    assert.equal(result.status, "ignored", title);
  }
});

test("ignores t-shirts and tees", () => {
  for (const title of [
    "Example Brand Logo T-Shirt",
    "Example Brand Pocket Tee"
  ]) {
    const result = classifyMoodProduct({
      title,
      vendor: "MOOD",
      body_html: "Pit to pit 22 in"
    }, fit);

    assert.equal(result.status, "ignored", title);
  }
});

test("classifies explicit UK 10.5 shoes as matches", () => {
  const result = classifyMoodProduct({
    title: "Example leather derby shoes",
    vendor: "MOOD",
    body_html: "",
    pageHtml: `
      <div class="attribute-item">
        <span class="attribute-value">Size: UK 10.5</span>
      </div>
    `
  }, fit);

  assert.equal(result.status, "strong_match");
  assert.equal(result.measurements.shoeUk, 10.5);
});

test("converts EU shoe sizes and rejects too-small pairs", () => {
  const result = classifyMoodProduct({
    title: "HERMES Quick H-Logo Leather Sneaker Brown",
    vendor: "HERMES",
    body_html: "",
    pageHtml: `
      <div class="attribute-item">
        <span class="attribute-value">Size: 42
Sole: 2 cm
Shoe height: 10.5 cm
Shoe width: 10 cm</span>
      </div>
    `
  }, fit);

  assert.equal(result.measurements.shoeEu, 42);
  assert.equal(result.status, "too_small");
  assert.match(result.reason, /UK 9/);
});

test("matches preferred Shopify variant sizes", () => {
  assert.equal(hasPreferredShopifySize({
    options: [{ name: "Size", values: ["S", "M", "XL"] }],
    variants: []
  }, ["M", "L"]), true);

  assert.equal(hasPreferredShopifySize({
    options: [{ name: "Size", values: ["Small"] }],
    variants: [{ title: "Large / Navy", option1: "Large", option2: "Navy" }]
  }, ["M", "L"]), true);
});

test("rejects Shopify products without preferred variant sizes", () => {
  assert.equal(hasPreferredShopifySize({
    options: [{ name: "Size", values: ["XS", "S", "XL"] }],
    variants: [{ title: "Small / Navy", option1: "Small", option2: "Navy" }]
  }, ["M", "L"]), false);
});
