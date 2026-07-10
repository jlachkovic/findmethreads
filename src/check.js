import { execFile } from "node:child_process";
import { copyFile, mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, "..");
const dataDir = path.join(rootDir, "data");
const configPath = path.join(rootDir, "config.json");
const exampleConfigPath = path.join(rootDir, "config.example.json");
const seenPath = path.join(dataDir, "seen-products.json");
const reportHtmlPath = path.join(dataDir, "latest-report.html");
const reportJsonPath = path.join(dataDir, "latest-report.json");
const reportIndexPath = path.join(dataDir, "index.html");

const GBP = new Intl.NumberFormat("en-GB", { style: "currency", currency: "GBP" });

async function main() {
  await mkdir(dataDir, { recursive: true });
  await ensureLocalConfig();
  const config = JSON.parse(await readFile(configPath, "utf8"));
  const seen = await readJson(seenPath, { products: {} });

  const crisisProducts = await fetchShopifyCollection(config.crisis.collectionUrl, config.run.maxProductsPerSite);
  await sleep(1000);
  const moodProducts = await fetchShopifyCollection(config.mood.collectionUrl, config.run.maxProductsPerSite);
  await sleep(1000);
  const jsArchiveProducts = await fetchJsArchiveProducts(config.jsArchive.shopUrl, config.jsArchive.maxPages);
  await sleep(1000);
  const bluehorseProducts = await fetchShopifyCollection(config.bluehorse.collectionUrl, config.run.maxProductsPerSite);
  const shopifyFitStoreResults = [];
  for (const store of config.shopifyFitStores ?? []) {
    await sleep(1000);
    try {
      shopifyFitStoreResults.push({
        store,
        products: await fetchShopifyCollection(store.collectionUrl, config.run.maxProductsPerSite)
      });
    } catch (error) {
      console.warn(`Skipped ${store.name ?? store.key}: ${error.message}`);
      shopifyFitStoreResults.push({ store, products: [] });
    }
  }

  const enrichedMoodProducts = await mapWithConcurrency(moodProducts, 3, enrichMoodProduct);

  const crisisMatches = crisisProducts
    .filter((product) => isAvailable(product))
    .filter((product) => inferGarment(product, productText(product).toLowerCase()) !== "ignored")
    .filter((product) => config.crisis.vendors.includes(product.vendor))
    .filter((product) => hasPreferredShopifySize(product, config.crisis.preferredLabelSizes ?? []))
    .map((product) => toMatch("crisis", product, {
      status: "strong_match",
      reason: `${product.vendor} appeared in the configured Shopify collection in a preferred size`
    }));

  const moodMatches = enrichedMoodProducts
    .filter((product) => isAvailable(product))
    .map((product) => toMatch("mood", product, classifyMoodProduct(product, config.mood.fit)))
    .filter((match) => ["strong_match", "maybe_match", "unknown_measurements"].includes(match.status));

  const jsArchiveMatches = jsArchiveProducts
    .filter(isJsArchiveCandidate)
    .map((product) => toMatch("jsarchive", product, classifyMoodProduct(product, config.jsArchive.fit)))
    .filter((match) => ["strong_match", "maybe_match"].includes(match.status));

  const bluehorseMatches = bluehorseProducts
    .filter((product) => isAvailable(product))
    .filter(isGeneralFitCandidate)
    .map((product) => toMatch("bluehorse", product, classifyMoodProduct(product, config.bluehorse.fit)))
    .filter((match) => ["strong_match", "maybe_match"].includes(match.status));

  const shopifyFitMatches = shopifyFitStoreResults.flatMap(({ store, products }) => products
    .filter((product) => isAvailable(product))
    .filter(isGeneralFitCandidate)
    .map((product) => toMatch(store.key, product, classifyMoodProduct(product, resolveFit(config, store)), store))
    .filter((match) => ["strong_match", "maybe_match"].includes(match.status)));

  const allMatches = [...crisisMatches, ...moodMatches, ...jsArchiveMatches, ...bluehorseMatches, ...shopifyFitMatches];
  const isFirstRun = Object.keys(seen.products).length === 0;
  const newMatches = isFirstRun ? [] : allMatches.filter((match) => !seen.products[match.key]);

  const now = new Date();
  for (const match of allMatches) {
    seen.products[match.key] ??= {
      firstSeenAt: now.toISOString(),
      title: match.title,
      site: match.site,
      url: match.url
    };
    seen.products[match.key].lastMatchedAt = now.toISOString();
    seen.products[match.key].status = match.status;
  }

  const report = {
    generatedAt: now.toISOString(),
    reportDate: dateStamp(now),
    firstRunSeeded: isFirstRun,
    newMatches,
    allMatches,
    checked: {
      crisis: crisisProducts.length,
      mood: moodProducts.length,
      jsArchive: jsArchiveProducts.length,
      bluehorse: bluehorseProducts.length,
      ...Object.fromEntries(shopifyFitStoreResults.map(({ store, products }) => [store.key, products.length]))
    }
  };

  await writeFile(seenPath, `${JSON.stringify(seen, null, 2)}\n`);
  await writeFile(reportJsonPath, `${JSON.stringify(report, null, 2)}\n`);
  await writeFile(reportHtmlPath, renderReport(report), "utf8");
  await writeArchivedReport(report);
  await writeReportIndex();

  if (newMatches.length && config.run.notifyOnMatches) {
    notify(`FindMeThreads: ${newMatches.length} new match${newMatches.length === 1 ? "" : "es"}`, "Open the latest report for links and fit notes.");
  }

  if (newMatches.length && config.run.openReportWhenMatchesFound) {
    openReport(reportHtmlPath);
  }

  printSummary(report);
}

async function ensureLocalConfig() {
  try {
    await readFile(configPath, "utf8");
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
    await copyFile(exampleConfigPath, configPath);
    console.warn("Created config.json from config.example.json. Edit it for your own watch list and fit.");
  }
}

async function fetchShopifyCollection(collectionUrl, limit) {
  const parsed = new URL(collectionUrl);
  parsed.pathname = `${parsed.pathname.replace(/\/$/, "")}/products.json`;

  const products = [];
  let page = 1;
  while (products.length < limit) {
    const url = new URL(parsed);
    url.searchParams.set("limit", String(Math.min(250, limit - products.length)));
    url.searchParams.set("page", String(page));

    const response = await fetchWithRetry(url, {
      headers: {
        "accept": "application/json",
        "user-agent": "findmethreads/0.1"
      }
    });

    if (!response.ok) {
      throw new Error(`Failed to fetch ${url}: ${response.status} ${response.statusText}`);
    }

    const body = await response.json();
    const batch = body.products ?? [];
    products.push(...batch);
    if (batch.length === 0 || batch.length < Math.min(250, limit - products.length + batch.length)) break;
    page += 1;
  }

  return products;
}

async function enrichMoodProduct(product) {
  try {
    const response = await fetchWithRetry(productUrl("mood", product), {
      headers: {
        "accept": "text/html",
        "user-agent": "findmethreads/0.1"
      }
    });
    if (!response.ok) return product;
    const pageHtml = await response.text();
    return { ...product, pageHtml };
  } catch {
    return product;
  }
}

async function fetchJsArchiveProducts(shopUrl, maxPages) {
  const productUrls = new Set();
  for (let page = 1; page <= maxPages; page += 1) {
    const url = new URL(shopUrl);
    if (page > 1) url.searchParams.set("page", String(page));
    const response = await fetchWithRetry(url, {
      headers: {
        "accept": "text/html",
        "user-agent": "findmethreads/0.1"
      }
    });
    if (!response.ok) break;
    const html = await response.text();
    for (const match of html.matchAll(/https:\/\/www\.jsarchive\.com\/product-page\/[^"'<\s]+/g)) {
      productUrls.add(match[0]);
    }
    if (!html.includes(`href="${shopUrl}?page=${page + 1}"`) && !html.includes(`href="${new URL(shopUrl).pathname}?page=${page + 1}"`)) {
      if (page > 1) break;
    }
    await sleep(500);
  }

  const products = await mapWithConcurrency([...productUrls], 3, fetchJsArchiveProduct);
  return products.filter(Boolean);
}

async function fetchJsArchiveProduct(url) {
  const response = await fetchWithRetry(url, {
    headers: {
      "accept": "text/html",
      "user-agent": "findmethreads/0.1"
    }
  });
  if (!response.ok) return null;
  const html = await response.text();
  const product = extractJsonLdProduct(html);
  if (!product) return null;
  const image = Array.isArray(product.image)
    ? product.image[0]?.contentUrl
    : product.image?.contentUrl ?? product.image;
  const offer = getCaseInsensitive(product, "offers");
  return {
    id: product.sku ?? slugFromUrl(url),
    title: htmlEntityDecode(product.name ?? slugFromUrl(url)),
    vendor: "J.S. Archive",
    body_html: htmlEntityDecode(product.description ?? ""),
    handle: slugFromUrl(url),
    url,
    images: image ? [image] : [],
    price: extractJsArchivePrice(product, html),
    published_at: null,
    available: offer?.availability || offer?.Availability ? !String(offer.availability ?? offer.Availability).includes("OutOfStock") : true
  };
}

export function extractJsArchivePrice(product, html = "") {
  const offer = getCaseInsensitive(product, "offers");
  const offerPrice = getCaseInsensitive(offer, "price");
  const productPrice = getCaseInsensitive(product, "price");
  const metaPrice = html.match(/<meta\s+property=["']product:price:amount["']\s+content=["']([^"']+)["']/i)?.[1];
  const wixPrice = html.match(/data-hook=["']formatted-primary-price["'][^>]*data-wix-price=["']£?([0-9,.]+)/i)?.[1];
  return parsePrice(offerPrice ?? productPrice ?? metaPrice ?? wixPrice);
}

function getCaseInsensitive(object, key) {
  if (!object || typeof object !== "object") return undefined;
  const foundKey = Object.keys(object).find((candidate) => candidate.toLowerCase() === key.toLowerCase());
  return foundKey ? object[foundKey] : undefined;
}

function parsePrice(value) {
  if (value === undefined || value === null || value === "") return undefined;
  const number = Number(String(value).replace(/[^0-9.]/g, ""));
  return Number.isFinite(number) ? number : undefined;
}

function extractJsonLdProduct(html) {
  for (const match of html.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)) {
    try {
      const data = JSON.parse(match[1]);
      const candidates = Array.isArray(data) ? data : [data];
      const product = candidates.find((entry) => entry?.["@type"] === "Product");
      if (product) return product;
    } catch {
      continue;
    }
  }
  return null;
}

function slugFromUrl(url) {
  return new URL(url).pathname.split("/").filter(Boolean).at(-1);
}

async function fetchWithRetry(url, options, attempts = 4) {
  let lastResponse;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const response = await fetch(url, options);
    if (!shouldRetry(response) || attempt === attempts) return response;
    lastResponse = response;
    const retryAfter = Number(response.headers.get("retry-after"));
    const delayMs = Number.isFinite(retryAfter) && retryAfter > 0
      ? retryAfter * 1000
      : 1000 * attempt * attempt;
    await sleep(delayMs);
  }
  return lastResponse;
}

function shouldRetry(response) {
  return response.status === 429 || response.status >= 500;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function classifyMoodProduct(product, fit) {
  const text = productText(product, product.pageHtml ? extractMoodAttributesHtml(product.pageHtml) : "");
  const lower = text.toLowerCase();
  const garment = inferGarment(product, lower);
  const measurements = extractMeasurements(text);
  const labelSize = extractLabelSize(text);

  if (hasAny(lower, [...fit.tops.avoidTerms, ...fit.bottoms.avoidTerms])) {
    return {
      status: "too_small",
      reason: "Listing uses a slim/tight fit term you said you dislike",
      garment,
      measurements,
      labelSize
    };
  }

  if (garment === "bottom") return classifyBottom(measurements, lower, fit.bottoms);
  if (garment === "top") return classifyTop(measurements, labelSize, lower, fit.tops);
  if (garment === "shoe") return classifyShoe(measurements, labelSize, lower, fit.shoes);
  if (garment === "ignored") {
    return {
      status: "ignored",
      reason: "Skipped garment type outside the current watch list",
      garment,
      measurements,
      labelSize
    };
  }

  return {
    status: "unknown_measurements",
    reason: "Could not confidently classify garment type or measurements yet",
    garment,
    measurements,
    labelSize
  };
}

function productText(product, extra = "") {
  return htmlToText([
    product.title,
    product.vendor,
    product.body_html ?? product.description ?? "",
    extra
  ].join("\n"));
}

function resolveFit(config, store) {
  if (store.fit) return store.fit;
  if (store.fitSource) return config[store.fitSource]?.fit;
  return config.mood.fit;
}

export function hasPreferredShopifySize(product, preferredSizes) {
  if (!preferredSizes.length) return true;
  const preferred = new Set(preferredSizes.map(normalizeLabelSize).filter(Boolean));
  return shopifySizeValues(product).some((value) => preferred.has(normalizeLabelSize(value)));
}

function shopifySizeValues(product) {
  const values = [];
  for (const option of product.options ?? []) {
    if (/\bsize\b/i.test(option.name ?? "")) values.push(...(option.values ?? []));
  }
  for (const variant of product.variants ?? []) {
    values.push(variant.option1, variant.option2, variant.option3);
    if (variant.title && variant.title !== "Default Title") values.push(...variant.title.split(/\s*\/\s*/));
  }
  return values.filter(Boolean);
}

function normalizeLabelSize(value) {
  const text = String(value ?? "").trim().toUpperCase();
  if (!text) return "";
  if (["MEDIUM", "M"].includes(text)) return "M";
  if (["LARGE", "L"].includes(text)) return "L";
  return text;
}

function isJsArchiveCandidate(product) {
  const text = productText(product).toLowerCase();
  if (isExcludedItemText(text)) {
    return false;
  }
  return inferGarment(product, text) !== "ignored";
}

function isGeneralFitCandidate(product) {
  const text = productText(product).toLowerCase();
  if (isExcludedItemText(text)) {
    return false;
  }
  return inferGarment(product, text) !== "ignored";
}

function isExcludedItemText(text) {
  return /\b(women|women's|female|look book|catalogue|catalog|book|bag|handbag|tote|scarf|scarves|tie|necktie|bow tie|belt|sunglasses|glasses|pumps|stilettos|skirt|dress|tunic|gown|blouse|t-shirt|tshirt|tee|tees)\b/.test(text);
}

function classifyShoe(measurements, labelSize, lower, fit) {
  const ukSize = measurements.shoeUk ?? euToUk(measurements.shoeEu) ?? parseShoeLabelAsUk(labelSize);
  const preferredTerm = hasAny(lower, fit.preferredTerms);

  if (!ukSize) {
    return {
      status: preferredTerm ? "unknown_measurements" : "ignored",
      reason: "Shoe-like item, but no UK/EU size was parsed",
      garment: "shoe",
      measurements,
      labelSize
    };
  }

  if (ukSize >= fit.minUk && ukSize <= fit.maxUk) {
    return {
      status: "strong_match",
      reason: `Shoe size looks right at about UK ${round(ukSize)}`,
      garment: "shoe",
      measurements,
      labelSize
    };
  }

  return {
    status: "too_small",
    reason: `Shoe size looks outside your range at about UK ${round(ukSize)}`,
    garment: "shoe",
    measurements,
    labelSize
  };
}

function classifyTop(measurements, labelSize, lower, fit) {
  const chest = measurements.chestIn ?? (measurements.pitToPitIn ? measurements.pitToPitIn * 2 : undefined);
  const preferredLabel = labelSize && fit.preferredLabelSizes.includes(labelSize.toUpperCase());
  const preferredCut = hasAny(lower, fit.preferTerms);
  const euSize = extractEuClothingSize(lower) ?? parseNumericSize(labelSize);
  const smallLabelNote = euSize && euSize < fit.minEuSize
    ? `, but label size IT/EU ${euSize} is below your preferred ${fit.preferredEuSize}`
    : "";

  if (chest) {
    if (chest >= fit.minChestIn && chest <= fit.idealMaxChestIn) {
      return {
        status: smallLabelNote ? "maybe_match" : "strong_match",
        reason: `Chest looks roomy but sane at about ${round(chest)} in${preferredCut ? ", with a preferred cut term" : ""}${smallLabelNote}`,
        garment: "top",
        measurements,
        labelSize
      };
    }
    if (chest > fit.idealMaxChestIn && chest <= fit.absoluteMaxChestIn) {
      return {
        status: "maybe_match",
        reason: `Chest is larger than ideal at about ${round(chest)} in, but might work oversized`,
        garment: "top",
        measurements,
        labelSize
      };
    }
    return {
      status: "too_small",
      reason: `Chest looks outside your range at about ${round(chest)} in`,
      garment: "top",
      measurements,
      labelSize
    };
  }

  if (preferredLabel || preferredCut) {
    return {
      status: "maybe_match",
      reason: `${preferredLabel ? `Label size ${labelSize}` : "Cut wording"} looks promising, but no chest measurement was parsed`,
      garment: "top",
      measurements,
      labelSize
    };
  }

  return {
    status: "unknown_measurements",
    reason: "Top-like item, but no chest or useful label-size signal was parsed",
    garment: "top",
    measurements,
    labelSize
  };
}

function classifyBottom(measurements, lower, fit) {
  const waist = measurements.waistIn;
  const inseam = measurements.inseamIn;
  const preferredCut = hasAny(lower, fit.preferTerms);

  if (!waist) {
    return {
      status: preferredCut ? "maybe_match" : "unknown_measurements",
      reason: preferredCut ? "Bottoms use promising cut wording, but no waist was parsed" : "Bottom-like item, but no waist was parsed",
      garment: "bottom",
      measurements
    };
  }

  const waistOk = waist >= fit.minWaistIn && waist <= fit.idealMaxWaistIn;
  const waistMaybe = waist > fit.idealMaxWaistIn && waist <= fit.absoluteMaxWaistIn;
  const inseamOk = !inseam || (inseam >= fit.minInseamIn && inseam <= fit.maxInseamIn);

  if (waistOk && inseamOk) {
    return {
      status: "strong_match",
      reason: `Waist looks right at about ${round(waist)} in${inseam ? ` with ${round(inseam)} in inseam` : ""}${preferredCut ? ", with a preferred cut term" : ""}`,
      garment: "bottom",
      measurements
    };
  }

  if ((waistMaybe && inseamOk) || (waistOk && !inseamOk)) {
    return {
      status: "maybe_match",
      reason: `Waist/inseam is close but needs a look: waist ${round(waist)} in${inseam ? `, inseam ${round(inseam)} in` : ""}`,
      garment: "bottom",
      measurements
    };
  }

  return {
    status: "too_small",
    reason: `Waist/inseam looks outside your range: waist ${round(waist)} in${inseam ? `, inseam ${round(inseam)} in` : ""}`,
    garment: "bottom",
    measurements
  };
}

export function extractMeasurements(text) {
  const normalized = text.replace(/\s+/g, " ");
  const measurements = {};
  const patterns = [
    ["chestIn", /\b(?:chest|bust)\b[^0-9]{0,24}(\d+(?:\.\d+)?)[ \t]*(cm\b|in\b|inch\b|inches\b|")?/ig],
    ["pitToPitIn", /\b(?:pit to pit|p2p|body width|width)\b[^0-9]{0,24}(\d+(?:\.\d+)?)[ \t]*(cm\b|in\b|inch\b|inches\b|")?/ig],
    ["shoulderIn", /\bshoulder(?: width| to shoulder)?\b[^0-9]{0,24}(\d+(?:\.\d+)?)[ \t]*(cm\b|in\b|inch\b|inches\b|")?/ig],
    ["waistIn", /\bwaist\b[^0-9]{0,24}(\d+(?:\.\d+)?)[ \t]*(cm\b|in\b|inch\b|inches\b|")?/ig],
    ["inseamIn", /\b(?:inseam|inside leg|inside seam)\b[^0-9]{0,24}(\d+(?:\.\d+)?)[ \t]*(cm\b|in\b|inch\b|inches\b|")?/ig],
    ["riseIn", /\brise\b[^0-9]{0,24}(\d+(?:\.\d+)?)[ \t]*(cm\b|in\b|inch\b|inches\b|")?/ig],
    ["lengthIn", /\blength(?: at back)?\b[^0-9]{0,24}(\d+(?:\.\d+)?)[ \t]*(cm\b|in\b|inch\b|inches\b|")?/ig]
  ];

  for (const [key, pattern] of patterns) {
    const match = [...normalized.matchAll(pattern)][0];
    if (!match) continue;
    measurements[key] = toInches(Number(match[1]), match[2]);
  }

  const shoeTerms = /\b(shoe|shoes|sneaker|sneakers|loafer|loafers|boot|boots|derby|footwear|trainers|lace-ups|puma)\b/i;
  return shoeTerms.test(normalized)
    ? { ...measurements, ...extractShoeMeasurements(normalized) }
    : measurements;
}

function extractShoeMeasurements(text) {
  const normalized = text.replace(/\s+/g, " ");
  const measurements = {};

  const explicitUk = normalized.match(/\b(?:uk|u\.k\.)\s*(?:size)?\s*:?\s*(\d+(?:\.\d+)?)/i)
    ?? normalized.match(/\bsize\s*:?\s*uk\s*(\d+(?:\.\d+)?)/i);
  if (explicitUk) measurements.shoeUk = Number(explicitUk[1]);

  const eu = normalized.match(/\b(?:eu|e\.u\.|eur|euro|european)\s*(?:size)?\s*:?\s*(\d+(?:\.\d+)?)/i)
    ?? normalized.match(/\bsize\s*:?\s*(3[8-9]|4[0-8])\b/i);
  if (eu) measurements.shoeEu = Number(eu[1]);

  return measurements;
}

function toInches(value, unit) {
  if (unit === "\"") return value;
  if (!unit || unit.toLowerCase() === "cm") return value / 2.54;
  return value;
}

function euToUk(euSize) {
  if (!euSize) return undefined;
  return euSize - 33;
}

function parseShoeLabelAsUk(labelSize) {
  if (!labelSize || !/^\d+(?:\.\d+)?$/.test(labelSize)) return undefined;
  const numeric = Number(labelSize);
  if (numeric >= 38) return euToUk(numeric);
  return numeric;
}

function parseNumericSize(labelSize) {
  if (!labelSize || !/^\d+(?:\.\d+)?$/.test(labelSize)) return undefined;
  return Number(labelSize);
}

function extractEuClothingSize(text) {
  const match = text.match(/\b(?:it|italian|eu|european)\s*(?:size)?\s*:?\s*(4[4-9]|5[0-8])\b/i)
    ?? text.match(/\bsize\s*(?:is\s*)?(?:listed\s*)?(?:using\s*)?(?:international\s*sizing,\s*including\s*)?(?:it|italian|eu|european)\s*(4[4-9]|5[0-8])\b/i);
  return match ? Number(match[1]) : undefined;
}

function extractLabelSize(text) {
  const match = text.match(/\b(?:label size|size)\b[^A-Z0-9]{0,12}(XS|S|M|L|XL|XXL|[0-9]{1,2})\b/i);
  return match?.[1];
}

function inferGarment(product, lower) {
  const title = `${product.title} ${product.type ?? ""}`.toLowerCase();
  if (/\b(skirt|dress|tunic|gown|bag|handbag|scarf|scarves|tie|necktie|bow tie|t-shirt|tshirt|tee|tees)\b/.test(title)) return "ignored";
  if (/\b(shoe|shoes|sneaker|sneakers|loafer|loafers|boot|boots|derby|footwear)\b/.test(title)) return "shoe";
  if (/\b(trouser|pants|jeans|denim|shorts|slacks)\b/.test(title)) return "bottom";
  if (/\b(shirt|jacket|coat|knit|sweater|cardigan|tee|t-shirt|polo|blouse|hoodie|sweatshirt|top)\b/.test(title)) return "top";
  if (/\bwaist|inseam|rise\b/.test(lower)) return "bottom";
  if (/\bchest|pit to pit|shoulder\b/.test(lower)) return "top";
  return "unknown";
}

function toMatch(site, product, classification, store = null) {
  const price = product.variants?.[0]?.price
    ? Number(product.variants[0].price)
    : product.price_min
      ? Number(product.price_min) / 100
      : product.price
        ? Number(product.price)
      : undefined;
  return {
    key: `${site}:${product.id}`,
    site,
    id: product.id,
    title: product.title,
    vendor: product.vendor,
    url: productUrl(site, product, store),
    image: product.images?.[0]?.src ?? product.images?.[0],
    price,
    publishedAt: product.published_at,
    status: classification.status,
    reason: classification.reason,
    garment: classification.garment,
    labelSize: classification.labelSize,
    measurements: classification.measurements ?? {}
  };
}

function isAvailable(product) {
  if (typeof product.available === "boolean") return product.available;
  return product.variants?.some((variant) => variant.available) ?? true;
}

function productUrl(site, product, store = null) {
  if (product.url) return product.url;
  if (store?.baseUrl) return `${store.baseUrl.replace(/\/$/, "")}/products/${product.handle}`;
  const bases = {
    crisis: "https://shopfromcrisis.org.uk",
    mood: "https://mood-by-link.com/en-uk",
    bluehorse: "https://bluehorse-clothing.com"
  };
  const base = bases[site] ?? bases.mood;
  return `${base}/products/${product.handle}`;
}

function extractMoodAttributesHtml(html) {
  const attributes = [];
  const labelledPattern = /<span class="attribute-label">([\s\S]*?)<\/span>\s*<span class="attribute-value">([\s\S]*?)<\/span>/gi;
  for (const match of html.matchAll(labelledPattern)) {
    attributes.push(`${htmlToText(match[1])} ${htmlToText(match[2])}`);
  }
  const valueOnlyPattern = /<span class="attribute-value">([\s\S]*?)<\/span>/gi;
  for (const match of html.matchAll(valueOnlyPattern)) {
    const value = htmlToText(match[1]);
    if (value && !attributes.some((attribute) => attribute.includes(value))) attributes.push(value);
  }
  return attributes.join("\n");
}

async function mapWithConcurrency(items, limit, mapper) {
  const results = new Array(items.length);
  let nextIndex = 0;

  async function worker() {
    while (nextIndex < items.length) {
      const index = nextIndex;
      nextIndex += 1;
      results[index] = await mapper(items[index], index);
    }
  }

  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

export function renderReport(report, rootPrefix = "") {
  const newSection = renderMatches("New matches", report.newMatches, report.firstRunSeeded);
  const allSection = renderMatches("All available matches", report.allMatches);
  const weekLinks = renderWeekLinks(report.reportDate, rootPrefix);
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>FindMeThreads Report</title>
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; margin: 32px; color: #191919; background: #faf8f3; }
    header { margin-bottom: 28px; }
    h1 { margin: 0 0 8px; font-size: 32px; }
    h2 { margin-top: 32px; border-bottom: 1px solid #d8d1c5; padding-bottom: 8px; }
    .meta { color: #615d55; }
    .grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(280px, 1fr)); gap: 16px; }
    article { background: white; border: 1px solid #ded7ca; border-radius: 8px; overflow: hidden; }
    img { width: 100%; aspect-ratio: 1 / 1; object-fit: cover; background: #eee; }
    .body { padding: 14px; }
    .site { text-transform: uppercase; font-size: 12px; letter-spacing: .06em; color: #676158; }
    h3 { margin: 6px 0 8px; font-size: 16px; line-height: 1.25; }
    a { color: #234f7a; }
    .badge { display: inline-block; padding: 3px 7px; border-radius: 999px; font-size: 12px; background: #e8eee5; color: #284a29; }
    .maybe_match, .unknown_measurements { background: #f6ead0; color: #6a4514; }
    .details { margin: 10px 0 0; color: #4d4942; font-size: 14px; }
    .empty { padding: 16px; background: white; border: 1px solid #ded7ca; border-radius: 8px; }
    nav { display: flex; gap: 12px; flex-wrap: wrap; margin-top: 14px; }
    nav a { background: white; border: 1px solid #ded7ca; border-radius: 8px; padding: 7px 10px; text-decoration: none; }
  </style>
</head>
<body>
  <header>
    <h1>FindMeThreads Report</h1>
    <div class="meta">Generated ${escapeHtml(new Date(report.generatedAt).toLocaleString("en-GB"))}. Checked ${escapeHtml(renderCheckedSummary(report.checked))}.${report.firstRunSeeded ? " First run seeded existing matches; future runs will only flag newly seen products." : ""}</div>
    <nav>
      <a href="${escapeHtml(rootPrefix)}index.html">Archive</a>
      ${weekLinks}
    </nav>
  </header>
  ${newSection}
  ${allSection}
</body>
</html>`;
}

function renderWeekLinks(reportDate, rootPrefix = "") {
  if (!reportDate) return "";
  const date = new Date(`${reportDate}T00:00:00Z`);
  return Array.from({ length: 7 }, (_, offset) => {
    const day = new Date(date);
    day.setUTCDate(date.getUTCDate() - offset);
    const stamp = dateStamp(day);
    return `<a href="${escapeHtml(rootPrefix)}reports/${stamp}/report.html">${escapeHtml(offset === 0 ? "Today" : stamp)}</a>`;
  }).join("");
}

function renderMatches(title, matches, firstRunSeeded = false) {
  if (!matches.length) {
    const message = firstRunSeeded ? "First run seeded existing matches. Future runs will only show newly seen products here." : "Nothing here this run.";
    return `<section><h2>${escapeHtml(title)}</h2><div class="empty">${escapeHtml(message)}</div></section>`;
  }
  return `<section><h2>${escapeHtml(title)}</h2><div class="grid">${matches.map(renderMatch).join("")}</div></section>`;
}

function renderMatch(match) {
  const measurements = Object.entries(match.measurements ?? {})
    .map(([key, value]) => `${key.replace(/In$/, "")}: ${round(value)} in`)
    .join(", ");
  return `<article>
    ${match.image ? `<img src="${escapeHtml(normalizeImage(match.image))}" alt="">` : ""}
    <div class="body">
      <div class="site">${escapeHtml(match.site)} · ${escapeHtml(match.vendor ?? "")}</div>
      <h3><a href="${escapeHtml(match.url)}">${escapeHtml(match.title)}</a></h3>
      <span class="badge ${escapeHtml(match.status)}">${escapeHtml(match.status.replace("_", " "))}</span>
      ${match.price ? `<div class="details">${escapeHtml(GBP.format(match.price))}</div>` : ""}
      <div class="details">${escapeHtml(match.reason)}</div>
      ${match.labelSize ? `<div class="details">Label size: ${escapeHtml(match.labelSize)}</div>` : ""}
      ${measurements ? `<div class="details">${escapeHtml(measurements)}</div>` : ""}
    </div>
  </article>`;
}

function printSummary(report) {
  console.log(`Checked ${renderCheckedSummary(report.checked)}.`);
  console.log(`New matches: ${report.newMatches.length}${report.firstRunSeeded ? " (first run seeded existing matches)" : ""}`);
  console.log(`Report: ${reportHtmlPath}`);
  console.log(`Archive: ${reportIndexPath}`);
  for (const match of report.newMatches) {
    console.log(`- [${match.site}] ${match.title} (${match.status})`);
    console.log(`  ${match.url}`);
  }
}

async function writeArchivedReport(report) {
  const reportDir = path.join(dataDir, "reports", report.reportDate);
  await mkdir(reportDir, { recursive: true });
  await writeFile(path.join(reportDir, "report.json"), `${JSON.stringify(report, null, 2)}\n`);
  await writeFile(path.join(reportDir, "report.html"), renderReport(report, "../../"), "utf8");
}

async function writeReportIndex() {
  const reportsDir = path.join(dataDir, "reports");
  await mkdir(reportsDir, { recursive: true });
  const dates = (await readdir(reportsDir, { withFileTypes: true }))
    .filter((entry) => entry.isDirectory() && /^\d{4}-\d{2}-\d{2}$/.test(entry.name))
    .map((entry) => entry.name)
    .sort()
    .reverse();

  const rows = [];
  for (const date of dates) {
    const report = await readJson(path.join(reportsDir, date, "report.json"), null);
    if (!report) continue;
    rows.push(`<tr>
      <td><a href="reports/${escapeHtml(date)}/report.html">${escapeHtml(date)}</a></td>
      <td>${escapeHtml(new Date(report.generatedAt).toLocaleString("en-GB"))}</td>
      <td>${report.newMatches?.length ?? 0}</td>
      <td>${report.allMatches?.length ?? 0}</td>
      <td>${escapeHtml(renderCheckedSummary(report.checked))}</td>
    </tr>`);
  }

  await writeFile(reportIndexPath, `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>FindMeThreads Archive</title>
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; margin: 32px; color: #191919; background: #faf8f3; }
    h1 { margin: 0 0 8px; font-size: 32px; }
    .meta { color: #615d55; margin-bottom: 20px; }
    table { width: 100%; border-collapse: collapse; background: white; border: 1px solid #ded7ca; }
    th, td { padding: 10px 12px; border-bottom: 1px solid #ded7ca; text-align: left; }
    th { background: #f1ece3; }
    a { color: #234f7a; }
  </style>
</head>
<body>
  <h1>FindMeThreads Archive</h1>
  <div class="meta">Each daily run is saved here. The latest run is also copied to <a href="latest-report.html">latest-report.html</a>.</div>
  <table>
    <thead><tr><th>Date</th><th>Generated</th><th>New</th><th>Available Matches</th><th>Checked</th></tr></thead>
    <tbody>${rows.join("") || `<tr><td colspan="5">No archived reports yet.</td></tr>`}</tbody>
  </table>
</body>
</html>`, "utf8");
}

function dateStamp(date) {
  return date.toISOString().slice(0, 10);
}

async function readJson(filePath, fallback) {
  try {
    return JSON.parse(await readFile(filePath, "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") return fallback;
    throw error;
  }
}

function notify(title, message) {
  const script = `display notification ${JSON.stringify(message)} with title ${JSON.stringify(title)}`;
  execFile("osascript", ["-e", script], () => {});
}

function openReport(filePath) {
  execFile("open", ["-a", "Google Chrome", filePath], () => {});
}

function htmlToText(html) {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, "\"")
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, " ")
    .trim();
}

function htmlEntityDecode(value) {
  return String(value ?? "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, "\"")
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">");
}

function renderCheckedSummary(checked = {}) {
  return Object.entries(checked)
    .map(([site, count]) => `${site}: ${count}`)
    .join(", ");
}

function hasAny(text, terms) {
  return terms.some((term) => text.includes(term.toLowerCase()));
}

function normalizeImage(src) {
  if (src.startsWith("//")) return `https:${src}`;
  return src;
}

function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function round(value) {
  return Math.round(value * 10) / 10;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
