/**
 * migrate_v2.mjs
 *
 * Script to migrate province/ward data to the new v2 format after Vietnam's
 * administrative merger. Fetches data from Central Retail MDI Address API.
 *
 * Output:
 *   - ../province.json         (updated with 34 merged provinces, same format)
 *   - ../provinces_v2/<CODE>.json  (2-level: province -> ward, no district)
 *
 * Usage:
 *   cd scripts && node migrate_v2.mjs
 */

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");

const API_BASE = "https://openapi-uat.centralretail.com.vn/group/mdi/address/v2";
const API_KEY = "2dI7Cirn9QwYzr7P3WjNNsnmjBoxyuBt";

// ---------------------------------------------------------------------------
// Helper: fetch with apikey header
// ---------------------------------------------------------------------------
async function apiFetch(url) {
  const res = await fetch(url, { headers: { apikey: API_KEY } });
  if (!res.ok) {
    throw new Error(`HTTP ${res.status} fetching ${url}`);
  }
  return res.json();
}

// ---------------------------------------------------------------------------
// Explicit code overrides - hand-curated for all 34 merged provinces
// ---------------------------------------------------------------------------
const CODE_OVERRIDES = {
  "An Giang": "AG",
  "Bắc Ninh": "BN",
  "Cà Mau": "CM",
  "Cao Bằng": "CB",
  "Cần Thơ": "CT",
  "Đà Nẵng": "DDN",
  "Đắk Lắk": "DDL",
  "Điện Biên": "DDB",
  "Đồng Nai": "DNA",
  "Đồng Tháp": "DDT",
  "Gia Lai": "GL",
  "Hà Nội": "HN",
  "Hà Tĩnh": "HT",
  "Hải Phòng": "HP",
  "Hồ Chí Minh": "HCM",
  "Huế": "HUE",
  "Hưng Yên": "HY",
  "Khánh Hòa": "KH",
  "Lai Châu": "LCH",
  "Lạng Sơn": "LS",
  "Lào Cai": "LCA",
  "Lâm Đồng": "LDD",
  "Nghệ An": "NA",
  "Ninh Bình": "NB",
  "Phú Thọ": "PT",
  "Quảng Ngãi": "QNG",
  "Quảng Ninh": "QNI",
  "Quảng Trị": "QT",
  "Sơn La": "SL",
  "Tây Ninh": "TNI",
  "Thái Nguyên": "TN",
  "Thanh Hóa": "TH",
  "Tuyên Quang": "TQ",
  "Vĩnh Long": "VL",
};

// ---------------------------------------------------------------------------
// Helper: get code for a province (from override table or auto-generated)
// ---------------------------------------------------------------------------
function generateCode(nameVi, usedCodes) {
  // Use override if available
  if (CODE_OVERRIDES[nameVi]) {
    const override = CODE_OVERRIDES[nameVi];
    if (!usedCodes.has(override)) return override;
  }

  // Fallback: auto-generate from initials
  const clean = nameVi
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/đ/gi, "d")
    .replace(/[^a-zA-Z\s]/g, "")
    .trim()
    .toUpperCase();

  const words = clean.split(/\s+/);

  // Strategy 1: initials of all words
  let code = words.map((w) => w[0]).join("");
  if (!usedCodes.has(code)) return code;

  // Strategy 2: append extra chars from last word
  for (let i = 2; i <= words[words.length - 1].length; i++) {
    code =
      words.slice(0, -1).map((w) => w[0]).join("") +
      words[words.length - 1].slice(0, i);
    if (!usedCodes.has(code)) return code;
  }

  // Fallback: numeric suffix
  let n = 1;
  const base = words.map((w) => w[0]).join("");
  while (usedCodes.has(`${base}${n}`)) n++;
  return `${base}${n}`;
}

// ---------------------------------------------------------------------------
// Helper: sleep to avoid hammering the API
// ---------------------------------------------------------------------------
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
async function main() {
  console.log("📡 Fetching provinces list...");
  const provincesResp = await apiFetch(`${API_BASE}/provinces`);
  const listProvinces = provincesResp.data.listProvinces;
  console.log(`✅ Got ${listProvinces.length} provinces.`);

  // Build province.json entries with generated codes
  const usedCodes = new Set();
  const provinceEntries = [];

  for (const p of listProvinces) {
    const nameVi = p.nameVi;
    const code = generateCode(nameVi, usedCodes);
    usedCodes.add(code);
    provinceEntries.push({ p, code, nameVi });
  }

  // Sort alphabetically by nameVi to keep province.json tidy
  provinceEntries.sort((a, b) => a.nameVi.localeCompare(b.nameVi, "vi"));

  // Create provinces_v2 output directory
  const outputDir = path.join(ROOT, "provinces_v2");
  if (!fs.existsSync(outputDir)) {
    fs.mkdirSync(outputDir);
    console.log(`📁 Created directory: provinces_v2/`);
  }

  // Build new province.json map
  const newProvinceJson = {};

  for (const { p, code, nameVi } of provinceEntries) {
    const filePath = `./provinces_v2/${code}.json`;
    newProvinceJson[nameVi] = { code, file_path: filePath };
  }

  // Fetch communes for each province and write province detail files
  let i = 0;
  for (const { p, code, nameVi } of provinceEntries) {
    i++;
    const provinceCode = p.code;
    process.stdout.write(
      `[${i}/${provinceEntries.length}] Fetching wards for ${nameVi} (code=${provinceCode})... `
    );

    try {
      const communesResp = await apiFetch(
        `${API_BASE}/province/${provinceCode}/communes`
      );
      const listWards = communesResp.data.listWards;
      process.stdout.write(`${listWards.length} wards\n`);

      // Build 2-level structure: province -> ward (flat list, no district)
      const provinceDetail = {
        vnCode: provinceCode,
        code: code,
        name: nameVi,
        ward: listWards.map((w) => ({
          vnCode: w.code,
          name: w.nameVi,
          pre: extractPrefix(w.fullNameVi, w.nameVi),
          legacy: w.legacy.map((l) => ({
            vnCode: l.code,
            name: l.nameVi,
            pre: extractPrefix(l.fullNameVi, l.nameVi),
          })),
        })),
      };

      const filePath = path.join(outputDir, `${code}.json`);
      fs.writeFileSync(filePath, JSON.stringify(provinceDetail, null, 2), "utf8");
    } catch (err) {
      process.stdout.write(`❌ ERROR: ${err.message}\n`);
    }

    // Small delay to be polite to the API
    await sleep(150);
  }

  // Write updated province.json
  const provinceJsonPath = path.join(ROOT, "province.json");
  fs.writeFileSync(
    provinceJsonPath,
    JSON.stringify(newProvinceJson, null, 2),
    "utf8"
  );

  console.log("\n✅ Done!");
  console.log(`   • province.json updated with ${Object.keys(newProvinceJson).length} provinces`);
  console.log(`   • Ward files written to provinces_v2/`);
}

/**
 * Extract the prefix (e.g. "Xã", "Phường", "Thị trấn") from a full name.
 * e.g. fullNameVi="Xã A Dơi", nameVi="A Dơi" → "Xã"
 */
function extractPrefix(fullNameVi, nameVi) {
  if (!fullNameVi || !nameVi) return "";
  const prefix = fullNameVi.replace(nameVi, "").trim();
  return prefix;
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
