#!/usr/bin/env node
/**
 * 高德坐标拾取器关键词查询脚本
 * ------------------------------------------------------------------
 * 用途：
 *   通过高德坐标拾取器背后的 place/text 搜索接口，按公园名称查询 GCJ-02 坐标，
 *   用于更新 docs/parks/data/parks.json。
 *
 * 重要：
 *   - 该接口与 https://lbs.amap.com/tools/picker 使用的接口同源。
 *   - 未登录时高德只返回 2 位小数，不能用于精确定位；必须在已登录高德开放平台的浏览器中
 *     复制 Cookie，并通过环境变量 AMAP_PICKER_COOKIE 传入，才能得到 6 位小数。
 *   - Cookie 只存在于当前命令的环境变量中，不会被写进仓库。
 *
 * 用法：
 *   # 只预览，不修改文件（默认）
 *   AMAP_PICKER_COOKIE='...' node scripts/fetch-amap-coords.mjs
 *
 *   # 确认候选无误后写回 parks.json
 *   AMAP_PICKER_COOKIE='...' node scripts/fetch-amap-coords.mjs --write
 *
 *   # 只更新指定 id
 *   AMAP_PICKER_COOKIE='...' node scripts/fetch-amap-coords.mjs --write --only=century-park,daning-park
 *
 * 可选参数：
 *   --data=docs/parks/data/parks.json
 *   --cookie-file=/path/to/cookie.txt   从文件读取 Cookie（避免超长环境变量）
 *   --key=...                           覆盖默认的拾取器 key
 *   --delay=500                         每次请求间隔（毫秒）
 *   --only=id1,id2                      只处理指定公园
 *   --verbose                           输出候选列表
 */
import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";

const ENDPOINT = "https://lbs.amap.com/AMapService/v3/place/text";
const REFERER = "https://lbs.amap.com/tools/picker";
const DEFAULT_KEY = "f7d40927ba4d64fb91ebe2bb9cda0995";
const DEFAULT_USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/155.0.0.0 Safari/537.36";

const args = process.argv.slice(2);

function getArg(name, fallback) {
  const index = args.indexOf(name);
  if (index !== -1 && args[index + 1] && !args[index + 1].startsWith("--")) {
    return args[index + 1];
  }
  const prefix = name + "=";
  const found = args.find(function (item) {
    return item.startsWith(prefix);
  });
  return found ? found.slice(prefix.length) : fallback;
}

function hasFlag(name) {
  return args.includes(name);
}

const WRITE = hasFlag("--write");
const VERBOSE = hasFlag("--verbose");
const DATA_FILE = path.resolve(
  process.cwd(),
  getArg("--data", path.join("docs", "parks", "data", "parks.json"))
);
const DELAY_MS = Math.max(0, Number(getArg("--delay", "500")) || 500);
const KEY = getArg("--key", process.env.AMAP_PICKER_KEY || DEFAULT_KEY);
const ONLY = new Set(
  String(getArg("--only", ""))
    .split(",")
    .map(function (id) {
      return id.trim();
    })
    .filter(Boolean)
);

let PICKER_COOKIE = process.env.AMAP_PICKER_COOKIE || "";

function sleep(ms) {
  return new Promise(function (resolve) {
    setTimeout(resolve, ms);
  });
}

function normalizeName(value) {
  return String(value || "")
    .replace(/\s+/g, "")
    .replace(/^上海市?/, "")
    .replace(/[（(].*?[）)]/g, "");
}

function coreName(value) {
  return normalizeName(value).replace(/公园$/, "");
}

function parseLocation(location) {
  if (typeof location !== "string") return null;
  const parts = location.split(",");
  const lng = Number(parts[0]);
  const lat = Number(parts[1]);
  if (!Number.isFinite(lng) || !Number.isFinite(lat)) return null;
  return {
    lng: lng,
    lat: lat,
    lngPrecision: decimalPlaces(parts[0]),
    latPrecision: decimalPlaces(parts[1])
  };
}

function decimalPlaces(value) {
  const text = String(value).trim();
  return text.includes(".") ? text.split(".")[1].length : 0;
}

function hasPreciseLocation(location) {
  return Boolean(
    location && location.lngPrecision >= 5 && location.latPrecision >= 5
  );
}

function haversineMeters(a, b) {
  const radius = 6371000;
  const toRad = function (degrees) {
    return (degrees * Math.PI) / 180;
  };
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const lat1 = toRad(a.lat);
  const lat2 = toRad(b.lat);
  const value =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) * Math.sin(dLng / 2);
  const clamped = Math.min(1, Math.max(0, value));
  return 2 * radius * Math.atan2(Math.sqrt(clamped), Math.sqrt(1 - clamped));
}

function scoreCandidate(poi, park) {
  const matchName = park.amapMatch || park.name;
  const parkName = normalizeName(matchName);
  const parkCore = coreName(matchName);
  const candidateName = normalizeName(poi.name);
  const candidateCore = coreName(poi.name);

  let score = -100;

  if (candidateName === parkName) {
    score = 120;
  } else if (candidateName.includes(parkName) || parkName.includes(candidateName)) {
    score = 90;
  } else if (
    parkCore &&
    candidateCore &&
    (candidateCore.includes(parkCore) || parkCore.includes(candidateCore))
  ) {
    score = 55;
  }

  if (poi.pname === "上海市") score += 20;
  if (park.district && poi.adname === park.district) score += 25;

  const type = String(poi.type || "");
  if (/公园|风景名胜|植物园|动物园/.test(type)) score += 5;
  if (/民宿|酒店|公寓|停车场|售票|入口|大门|旁/.test(poi.name)) score -= 120;

  const location = parseLocation(poi.location);
  if (hasPreciseLocation(location)) score += 3;

  return score;
}

function chooseBestPoi(pois, park) {
  const scored = pois
    // 过滤公交站、地铁站、停车场、酒店等非公园 POI，避免名称相似导致的误匹配。
    .filter(function (poi) {
      return !/公交站|地铁站|车站|停车场|售票|入口|大门|民宿|酒店|公寓|售票|旁/.test(
        String(poi.name || "")
      );
    })
    .map(function (poi) {
      return { poi: poi, score: scoreCandidate(poi, park) };
    })
    .sort(function (a, b) {
      return b.score - a.score;
    });

  return scored.length && scored[0].score >= 40 ? scored[0] : null;
}

function buildKeyword(park) {
  // 个别公园在高德的 POI 名称与项目展示名不同，可用 amapQuery 指定搜索词。
  if (park.amapQuery) return String(park.amapQuery);
  const name = /^上海/.test(park.name) ? park.name : "上海" + park.name;
  return name;
}

function buildRequestUrl(keyword) {
  const callback = "jsonp_" + Date.now() + "_" + Math.floor(Math.random() * 100000);
  const url = new URL(ENDPOINT);
  const params = {
    platform: "JS",
    s: "rsv3",
    logversion: "2.0",
    key: KEY,
    sdkversion: "2.3.5.13",
    // 拾取器页面自身使用的 appname（需要二次 URL 编码，和浏览器请求保持一致）
    appname: "https%3A%2F%2Flbs.amap.com%2Ftools%2Fpicker",
    csid: randomUUID().toUpperCase(),
    city: "310000",
    page: "1",
    offset: "20",
    extensions: "all",
    language: "zh_cn",
    type_: "KEYWORD",
    antiCrab: "true",
    keywords: keyword,
    callback: callback
  };

  Object.keys(params).forEach(function (name) {
    url.searchParams.set(name, params[name]);
  });

  return { url: url.toString(), callback: callback };
}

function parseJsonp(text, callback) {
  const marker = callback + "(";
  const start = text.indexOf(marker);
  if (start === -1) {
    throw new Error("响应不是预期的 JSONP 格式");
  }

  const bodyStart = start + marker.length;
  const end = text.lastIndexOf(")");
  if (end <= bodyStart) {
    throw new Error("JSONP 响应不完整");
  }

  return JSON.parse(text.slice(bodyStart, end));
}

async function fetchPois(keyword) {
  const request = buildRequestUrl(keyword);
  const headers = {
    accept: "*/*",
    "accept-language": "zh-CN,zh;q=0.9",
    "cache-control": "no-cache",
    pragma: "no-cache",
    referer: REFERER,
    "user-agent": DEFAULT_USER_AGENT,
    "sec-fetch-dest": "script",
    "sec-fetch-mode": "no-cors",
    "sec-fetch-site": "same-origin"
  };

  if (PICKER_COOKIE) {
    headers.cookie = PICKER_COOKIE;
  }

  const controller = new AbortController();
  const timeout = setTimeout(function () {
    controller.abort();
  }, 20000);

  try {
    const response = await fetch(request.url, {
      headers: headers,
      signal: controller.signal,
      cache: "no-store"
    });

    const text = await response.text();
    if (!response.ok) {
      throw new Error("HTTP " + response.status + "：" + text.slice(0, 200));
    }

    const payload = parseJsonp(text, request.callback);
    if (payload.status !== "1") {
      throw new Error(payload.info || "高德接口返回失败");
    }

    return Array.isArray(payload.pois) ? payload.pois : [];
  } finally {
    clearTimeout(timeout);
  }
}

async function loadCookieFromFile() {
  const file = getArg("--cookie-file", "");
  if (!file) return;
  const content = await fs.readFile(path.resolve(process.cwd(), file), "utf8");
  PICKER_COOKIE = content.trim();
}

async function main() {
  await loadCookieFromFile();

  if (WRITE && !PICKER_COOKIE) {
    throw new Error(
      "--write 需要登录后的 AMAP_PICKER_COOKIE；否则高德只返回 2 位小数，无法写入准确坐标"
    );
  }

  const data = JSON.parse(await fs.readFile(DATA_FILE, "utf8"));
  if (!Array.isArray(data)) {
    throw new Error("parks.json 必须是数组");
  }

  const parks = ONLY.size
    ? data.filter(function (park) {
        return ONLY.has(park.id);
      })
    : data;

  if (!parks.length) {
    throw new Error("没有匹配的公园记录");
  }

  if (!PICKER_COOKIE) {
    console.warn(
      "⚠️  未提供 AMAP_PICKER_COOKIE。高德只会返回 2 位小数，脚本仍可预览候选，但不会写入坐标。"
    );
  }

  console.log("数据文件：" + DATA_FILE);
  console.log("模式：" + (WRITE ? "写入" : "预览（不修改文件）"));
  console.log("待查询：" + parks.length + " 个公园\n");

  const updates = [];
  const skipped = [];

  for (let index = 0; index < parks.length; index += 1) {
    const park = parks[index];
    const keyword = buildKeyword(park);

    process.stdout.write(
      "[" + (index + 1) + "/" + parks.length + "] " + park.name + " … "
    );

    try {
      const pois = await fetchPois(keyword);
      const best = chooseBestPoi(pois, park);

      if (VERBOSE) {
        console.log("");
        pois.slice(0, 5).forEach(function (poi) {
          console.log(
            "    候选：" +
              poi.name +
              " | " +
              (poi.adname || "") +
              " | " +
              (poi.address || "") +
              " | " +
              poi.location
          );
        });
      }

      if (!best) {
        console.log("跳过（没有匹配到可信结果）");
        skipped.push({ park: park, reason: "无匹配结果" });
        await sleep(DELAY_MS);
        continue;
      }

      const location = parseLocation(best.poi.location);
      if (!location) {
        console.log("跳过（返回坐标无效）");
        skipped.push({ park: park, reason: "坐标无效" });
        await sleep(DELAY_MS);
        continue;
      }

      const precise = hasPreciseLocation(location);
      const delta = haversineMeters(
        { lng: park.lng, lat: park.lat },
        { lng: location.lng, lat: location.lat }
      );

      console.log(
        best.poi.name +
          " | " +
          best.poi.location +
          " | 偏移 " +
          Math.round(delta) +
          " m" +
          (precise ? "" : " | 精度不足（需登录 Cookie）")
      );

      if (WRITE) {
        if (!precise) {
          skipped.push({ park: park, reason: "坐标精度不足，未写入" });
        } else {
          park.lng = location.lng;
          park.lat = location.lat;
          updates.push({
            id: park.id,
            name: park.name,
            lng: location.lng,
            lat: location.lat,
            address: best.poi.address || "",
            adname: best.poi.adname || ""
          });
        }
      } else if (precise) {
        updates.push({
          id: park.id,
          name: park.name,
          lng: location.lng,
          lat: location.lat,
          address: best.poi.address || "",
          adname: best.poi.adname || ""
        });
      }
    } catch (error) {
      console.log("请求失败：" + error.message);
      skipped.push({ park: park, reason: error.message });
    }

    await sleep(DELAY_MS);
  }

  if (WRITE && updates.length) {
    await fs.writeFile(DATA_FILE, JSON.stringify(data, null, 2) + "\n", "utf8");
    console.log("\n✅ 已写入 " + updates.length + " 条坐标：" + DATA_FILE);
  }

  console.log("\n结果汇总");
  console.log("可写入/可预览：" + updates.length + " 条");
  if (updates.length) {
    updates.forEach(function (item) {
      console.log(
        "  " +
          item.name +
          " → " +
          item.lng.toFixed(6) +
          "," +
          item.lat.toFixed(6) +
          (item.adname ? "  [" + item.adname + "]" : "")
      );
    });
  }

  if (skipped.length) {
    console.log("跳过：" + skipped.length + " 条");
    skipped.forEach(function (item) {
      console.log("  " + item.park.name + "：" + item.reason);
    });
  }

  if (!WRITE) {
    console.log("\n当前为预览模式；确认候选无误后加 --write 写回。");
  }
}

main().catch(function (error) {
  console.error("\n脚本失败：" + error.message);
  process.exitCode = 1;
});
