/**
 * 上海地铁找厕所
 * ------------------------------------------------------------------
 * 时间估算使用「有向加权图 + Dijkstra」：
 *
 * 1. 图中的节点是（线路, 站点, 行驶方向）。同一座车站会因为线路和方向不同
 *    产生多个节点，这样“往莘庄”和“往富锦路”可以拥有完全不同的路径。
 * 2. 乘车边只指向当前方向的下一站，权重为该线路的 avgMinutesPerStop。
 * 3. 换乘边连接同一站点的不同线路/方向，权重优先查 transfers.json 的
 *    overrides，查不到用 default。
 * 4. 起点额外增加两条虚拟边：当前方向 0 分钟、反方向 5 分钟。反方向这条
 *    边就是需求中的“往回坐加 5 分钟”，并且只加一次。
 * 5. 从起点跑一次 Dijkstra 即可得到到所有站点的最短时间，再对筛选后的
 *    厕所按时间升序排列；排在第一的就是当前条件下的最优厕所。
 *
 * 注意：这是简化模型，不含站内步行、安检、候车和首末班车时间；
 * 所有时间与厕所信息都以页面上的“估算 / 以现场为准”提示为准。
 */
(function () {
  "use strict";

  var DATA_PATHS = {
    toilets: "data/toilets.json",
    lines: "data/lines.json",
    transfers: "data/transfers.json"
  };
  var SOURCE_NODE = "__source__";
  var BACKTRACK_MINUTES = 5;
  var collator = new Intl.Collator("zh-Hans-CN", {
    numeric: true,
    sensitivity: "base"
  });

  var state = {
    stations: [],
    stationById: new Map(),
    lines: {},
    transfers: { default: 6, overrides: {} },
    graph: null,
    routeCache: new Map(),
    currentLineId: "",
    currentSign: 1,
    currentStationId: "",
    direction: null,
    filters: { inside: false, familyFacility: false, acceptTransfer: true }
  };

  var dom = {};

  function byId(id) {
    return document.getElementById(id);
  }

  function init() {
    cacheDom();
    bindEvents();
    loadData();
  }

  function cacheDom() {
    dom.form = byId("toilet-query");
    dom.serviceSelect = byId("travel-service");
    dom.stationSelect = byId("current-station");
    dom.onlyInside = byId("filter-inside");
    dom.familyFacility = byId("filter-family");
    dom.acceptTransfer = byId("filter-transfer");
    dom.resultsList = byId("toilet-results");
    dom.resultCount = byId("result-count");
    dom.resultSummary = byId("result-summary");
    dom.routeStatus = byId("route-status");
    dom.stationCount = document.querySelectorAll("[data-station-count]");
    dom.toiletCount = document.querySelectorAll("[data-toilet-count]");
    dom.loading = byId("toilet-loading");
    dom.error = byId("toilet-error");
    dom.planner = document.querySelector(".toilet-planner");
  }

  function bindEvents() {
    dom.form.addEventListener("submit", function (event) {
      event.preventDefault();
    });
    dom.serviceSelect.addEventListener("change", function () {
      var direction = parseDirection(dom.serviceSelect.value);
      if (!direction) return;
      state.currentLineId = direction.lineId;
      state.currentSign = direction.sign;
      state.direction = direction;
      updateStationOptions();
      updateServiceColor();
      runQuery();
    });
    dom.stationSelect.addEventListener("change", function () {
      state.currentStationId = dom.stationSelect.value;
      runQuery();
    });
    [dom.onlyInside, dom.familyFacility, dom.acceptTransfer].forEach(function (input) {
      input.addEventListener("change", function () {
        readFilters();
        runQuery();
      });
    });
    dom.resultsList.addEventListener("click", function (event) {
      var retry = event.target.closest("[data-retry-toilets]");
      if (retry) loadData();
    });
    dom.error.addEventListener("click", function (event) {
      var retry = event.target.closest("[data-retry-toilets]");
      if (retry) loadData();
    });
  }

  /* ------------------------------------------------------------------
   * 数据加载与校验
   * ------------------------------------------------------------------ */
  function loadData() {
    showLoading();
    dom.error.hidden = true;
    dom.loading.hidden = false;

    Promise.all(
      Object.keys(DATA_PATHS).map(function (key) {
        return fetch(DATA_PATHS[key], { cache: "no-cache" }).then(function (response) {
          if (!response.ok) throw new Error(DATA_PATHS[key] + " HTTP " + response.status);
          return response.json();
        });
      })
    )
      .then(function (payloads) {
        state.lines = payloads[1] && typeof payloads[1] === "object" ? payloads[1] : {};
        state.transfers = normalizeTransfers(payloads[2]);
        state.stations = normalizeStations(payloads[0], state.lines);
        state.stationById = new Map(
          state.stations.map(function (station) {
            return [station.stationId, station];
          })
        );

        if (!state.stations.length) {
          throw new Error("toilets.json 没有可用站点");
        }

        state.graph = buildDirectedGraph(state.lines, state.transfers);
        state.routeCache.clear();
        populateServiceOptions();
        updateHeaderCounts();

        state.currentLineId = state.lines["1"] ? "1" : Object.keys(state.lines)[0];
        state.currentSign = 1;
        dom.serviceSelect.value = state.currentLineId + "|" + state.currentSign;
        state.direction = parseDirection(dom.serviceSelect.value);
        updateStationOptions("人民广场");
        updateServiceColor();
        dom.loading.hidden = true;
        runQuery();
      })
      .catch(function (error) {
        console.error("地铁厕所数据加载失败：", error);
        dom.loading.hidden = true;
        showError(error.message);
      });
  }

  function normalizeTransfers(raw) {
    var data = raw && typeof raw === "object" ? raw : {};
    return {
      default: Number.isFinite(Number(data.default)) ? Number(data.default) : 6,
      overrides:
        data.overrides && typeof data.overrides === "object" ? data.overrides : {}
    };
  }

  function normalizeStations(rawStations, lines) {
    if (!Array.isArray(rawStations)) return [];

    return rawStations
      .map(function (raw) {
        if (!raw || typeof raw !== "object") return null;

        var stationId = String(raw.stationId || "").trim();
        var stationName = String(raw.stationName || "").trim();
        if (!stationId || !stationName) return null;

        var stationLines = Array.isArray(raw.lines)
          ? raw.lines
              .map(String)
              .filter(function (lineId) {
                return (
                  lines[lineId] &&
                  Array.isArray(lines[lineId].stations) &&
                  lines[lineId].stations.indexOf(stationName) !== -1
                );
              })
          : [];

        if (!stationLines.length) {
          console.warn("站点没有匹配的线路数据，已跳过：", stationName);
          return null;
        }

        var toilets = Array.isArray(raw.toilets)
          ? raw.toilets
              .map(function (toilet) {
                if (!toilet || !toilet.id) return null;
                var type = toilet.type === "outside" ? "outside" : "inside";
                return {
                  id: String(toilet.id),
                  type: type,
                  location: String(toilet.location || ""),
                  nearExit: String(toilet.nearExit || ""),
                  hasFamily: Boolean(toilet.hasFamily),
                  hasBabyCare: Boolean(toilet.hasBabyCare),
                  accessible: Boolean(toilet.accessible),
                  note: String(toilet.note || "以现场为准")
                };
              })
              .filter(Boolean)
          : [];

        if (!toilets.length) return null;

        return {
          stationId: stationId,
          stationName: stationName,
          lines: stationLines,
          toilets: toilets
        };
      })
      .filter(Boolean)
      .sort(function (a, b) {
        return collator.compare(a.stationName, b.stationName);
      });
  }

  function updateHeaderCounts() {
    var stationTotal = state.stations.length;
    var toiletTotal = state.stations.reduce(function (sum, station) {
      return sum + station.toilets.length;
    }, 0);
    dom.stationCount.forEach(function (node) {
      node.textContent = String(stationTotal);
    });
    dom.toiletCount.forEach(function (node) {
      node.textContent = String(toiletTotal);
    });
  }

  function populateServiceOptions() {
    var options = [];

    Object.keys(state.lines).forEach(function (lineId) {
      var line = state.lines[lineId];
      if (!line || !Array.isArray(line.stations) || line.stations.length < 2) return;

      [1, -1].forEach(function (sign) {
        var destination =
          sign === 1 ? line.stations[line.stations.length - 1] : line.stations[0];
        options.push({
          value: lineId + "|" + sign,
          lineId: lineId,
          label: getLineName(lineId) + " · 往" + destination + "方向"
        });
      });
    });

    dom.serviceSelect.innerHTML = options
      .map(function (option) {
        var textColor = getLineTextColor(option.lineId);
        var tint = getLineTint(option.lineId);
        return (
          '<option value="' +
          escapeAttr(option.value) +
          '" style="color:' +
          escapeAttr(textColor) +
          ';background-color:' +
          escapeAttr(tint) +
          '">' +
          escapeHtml(option.label) +
          "</option>"
        );
      })
      .join("");
  }

  function updateStationOptions(preferredName) {
    var line = state.lines[state.currentLineId];
    if (!line) {
      dom.stationSelect.innerHTML = "";
      dom.stationSelect.disabled = true;
      state.currentStationId = "";
      return;
    }

    var indexByName = new Map(
      line.stations.map(function (stationName, index) {
        return [stationName, index];
      })
    );
    var directionStep = state.currentSign === -1 ? -1 : 1;

    var candidates = state.stations
      .filter(function (station) {
        return station.lines.indexOf(state.currentLineId) !== -1;
      })
      .sort(function (a, b) {
        var indexA = indexByName.has(a.stationName)
          ? indexByName.get(a.stationName)
          : Number.MAX_SAFE_INTEGER;
        var indexB = indexByName.has(b.stationName)
          ? indexByName.get(b.stationName)
          : Number.MAX_SAFE_INTEGER;
        return (indexA - indexB) * directionStep;
      });

    dom.stationSelect.innerHTML = candidates
      .map(function (station) {
        return (
          '<option value="' +
          escapeAttr(station.stationId) +
          '">' +
          escapeHtml(station.stationName) +
          "</option>"
        );
      })
      .join("");
    dom.stationSelect.disabled = !candidates.length;

    var preferred = preferredName
      ? candidates.find(function (station) {
          return station.stationName === preferredName;
        })
      : null;
    var preserved = candidates.find(function (station) {
      return station.stationId === state.currentStationId;
    });
    var peopleSquare = candidates.find(function (station) {
      return station.stationName === "人民广场";
    });
    var selected = preferred || preserved || peopleSquare || candidates[0];

    state.currentStationId = selected ? selected.stationId : "";
    dom.stationSelect.value = state.currentStationId;
  }

  /* ------------------------------------------------------------------
   * 有向加权图：节点 = 线路 + 站点 + 方向
   * ------------------------------------------------------------------ */
  function nodeKey(lineId, stationName, direction) {
    return lineId + "||" + stationName + "||" + direction;
  }

  function buildDirectedGraph(lines, transfers) {
    var adjacency = new Map();
    var stationLines = new Map();

    function ensureNode(key) {
      if (!adjacency.has(key)) adjacency.set(key, []);
    }

    function addEdge(from, to, weight, meta) {
      ensureNode(from);
      ensureNode(to);
      adjacency.get(from).push({
        to: to,
        weight: weight,
        meta: meta
      });
    }

    Object.keys(lines).forEach(function (lineId) {
      var line = lines[lineId];
      var stations = Array.isArray(line.stations) ? line.stations : [];
      var avg = Number(line.avgMinutesPerStop);

      if (!stations.length || !Number.isFinite(avg) || avg <= 0) return;

      stations.forEach(function (stationName, index) {
        if (!stationLines.has(stationName)) stationLines.set(stationName, []);
        stationLines.get(stationName).push(lineId);

        [1, -1].forEach(function (direction) {
          var fromKey = nodeKey(lineId, stationName, direction);
          ensureNode(fromKey);

          var nextIndex = index + direction;
          if (line.loop) {
            nextIndex = (nextIndex + stations.length) % stations.length;
          }
          if (nextIndex < 0 || nextIndex >= stations.length) return;

          addEdge(
            fromKey,
            nodeKey(lineId, stations[nextIndex], direction),
            avg,
            {
              type: "ride",
              lineId: lineId,
              direction: direction,
              fromStation: stationName,
              toStation: stations[nextIndex]
            }
          );
        });
      });
    });

    // 同一站点的不同线路之间建立双向换乘边；每条边的权重按“站点 + 线路对”查 transfers。
    stationLines.forEach(function (lineIds, stationName) {
      if (lineIds.length < 2) return;

      for (var i = 0; i < lineIds.length; i += 1) {
        for (var j = 0; j < lineIds.length; j += 1) {
          if (i === j) continue;
          var minutes = getTransferMinutes(
            stationName,
            lineIds[i],
            lineIds[j],
            transfers
          );
          [1, -1].forEach(function (fromDirection) {
            [1, -1].forEach(function (toDirection) {
              addEdge(
                nodeKey(lineIds[i], stationName, fromDirection),
                nodeKey(lineIds[j], stationName, toDirection),
                minutes,
                {
                  type: "transfer",
                  stationName: stationName,
                  fromLineId: lineIds[i],
                  toLineId: lineIds[j],
                  minutes: minutes
                }
              );
            });
          });
        }
      }
    });

    return {
      adjacency: adjacency,
      stationLines: stationLines
    };
  }

  /**
   * 线路显示名：数据里同时有数字线路、支线、浦江线、磁浮线、市域机场线。
   * 不能简单拼“号线”，否则会出现“pujiang号线”。
   */
  function getLineName(lineId) {
    var line = state.lines[lineId];
    return line && line.name ? line.name : lineId + "号线";
  }

  function getLineColor(lineId) {
    var line = state.lines[lineId];
    return line && line.color ? line.color : "#24483a";
  }

  function hexToRgb(hex) {
    var value = String(hex || "").replace("#", "");
    if (value.length === 3) {
      value = value
        .split("")
        .map(function (part) {
          return part + part;
        })
        .join("");
    }
    var number = parseInt(value, 16);
    if (!Number.isFinite(number)) return { r: 36, g: 72, b: 58 };
    return {
      r: (number >> 16) & 255,
      g: (number >> 8) & 255,
      b: number & 255
    };
  }

  /**
   * 下拉选项直接使用官方线路色；对黄、浅绿等亮色做压暗处理，
   * 保证在白底下拉框中仍然可读。
   */
  function getLineTextColor(lineId) {
    var rgb = hexToRgb(getLineColor(lineId));
    var luminance = 0.2126 * rgb.r + 0.7152 * rgb.g + 0.0722 * rgb.b;
    if (luminance <= 145) {
      return getLineColor(lineId);
    }
    return (
      "rgb(" +
      Math.round(rgb.r * 0.52) +
      ", " +
      Math.round(rgb.g * 0.52) +
      ", " +
      Math.round(rgb.b * 0.52) +
      ")"
    );
  }

  function getLineTint(lineId) {
    var rgb = hexToRgb(getLineColor(lineId));
    return (
      "rgba(" +
      rgb.r +
      ", " +
      rgb.g +
      ", " +
      rgb.b +
      ", 0.08)"
    );
  }

  function updateServiceColor() {
    var color = getLineColor(state.currentLineId);
    if (dom.serviceSelect) {
      dom.serviceSelect.style.setProperty("--line-color", color);
      dom.serviceSelect.style.color = getLineTextColor(state.currentLineId);
    }
    if (dom.routeStatus) {
      dom.routeStatus.style.setProperty("--line-color", color);
    }
  }

  /**
   * 线路号排序：数字线路按数值排序（2 < 15），机场等非数字线路排在最后。
   * 这样 8-1 会得到 1-8，15-2 会得到 2-15，配置一次即可双向命中。
   */
  function compareLineIds(a, b) {
    var numberA = Number(a);
    var numberB = Number(b);
    var aIsNumber = String(a).trim() !== "" && Number.isFinite(numberA);
    var bIsNumber = String(b).trim() !== "" && Number.isFinite(numberB);

    if (aIsNumber && bIsNumber) return numberA - numberB;
    if (aIsNumber) return -1;
    if (bIsNumber) return 1;
    return String(a).localeCompare(String(b), "zh-Hans-CN");
  }

  /**
   * 生成换乘键：站点名:较小线路-较大线路。
   * 线路顺序已排序，因此 1-8 和 8-1 会命中同一个键，不需要重复配置。
   */
  function buildTransferKey(stationName, fromLine, toLine) {
    var pair = [String(fromLine), String(toLine)].sort(compareLineIds);
    return String(stationName) + ":" + pair[0] + "-" + pair[1];
  }

  /**
   * 换乘字典查表：
   * 1. 用站点名 + 排序后的线路对拼出 key；
   * 2. overrides 命中则用配置值；
   * 3. 未配置的线路对回退到 default（默认 6 分钟）。
   * 使用 hasOwnProperty，避免 "constructor" 等原型键误命中。
   */
  function getTransferMinutes(stationName, fromLine, toLine, transfers) {
    var key = buildTransferKey(stationName, fromLine, toLine);
    if (
      transfers &&
      transfers.overrides &&
      Object.prototype.hasOwnProperty.call(transfers.overrides, key)
    ) {
      var value = Number(transfers.overrides[key]);
      if (Number.isFinite(value)) return value;
    }
    return transfers && Number.isFinite(Number(transfers.default))
      ? Number(transfers.default)
      : 6;
  }

  /**
   * 从“当前站 + 当前线路 + 行驶方向”跑一次 Dijkstra。
   * 返回每个站点 ID 对应的最优路线，供所有厕所复用。
   */
  function computeRoutes(station, direction) {
    if (!state.graph || !station || !direction) return new Map();

    var startKey = nodeKey(direction.lineId, station.stationName, direction.sign);
    var reverseKey = nodeKey(direction.lineId, station.stationName, -direction.sign);

    /*
     * 起点虚拟边：
     * - 当前方向：0 分钟
     * - 反方向：5 分钟（规则 2，只对起点这一次反向收费）
     * 因此“往回坐”不是事后拍脑袋加时间，而是一条真正的有向边。
     */
    var sourceEdges = [
      {
        to: startKey,
        weight: 0,
        meta: { type: "start", reverse: false }
      },
      {
        to: reverseKey,
        weight: BACKTRACK_MINUTES,
        meta: { type: "start", reverse: true }
      }
    ];

    function neighbors(key) {
      if (key === SOURCE_NODE) return sourceEdges;

      var edges = state.graph.adjacency.get(key) || [];

      /*
       * 起点状态只允许先乘车，不允许在原地立刻换到另一条线。
       * 否则用户明明选了 2 号线，最优路径却可能一步没坐就先“换乘”到 1 号线，
       * 方向选择就失去意义了。真正需要换乘时，先坐一站再换即可。
       */
      if (key === startKey || key === reverseKey) {
        return edges.filter(function (edge) {
          return edge.meta.type === "ride";
        });
      }

      return edges;
    }

    var distances = new Map();
    var previous = new Map();
    var heap = new MinHeap();

    distances.set(SOURCE_NODE, 0);
    heap.push(SOURCE_NODE, 0);

    while (heap.size) {
      var current = heap.pop();
      var node = current.node;
      var cost = current.cost;
      var knownCost = distances.has(node) ? distances.get(node) : Infinity;

      if (cost > knownCost) continue;

      var edges = neighbors(node);
      for (var i = 0; i < edges.length; i += 1) {
        var edge = edges[i];
        var nextCost = cost + edge.weight;
        var existingCost = distances.has(edge.to)
          ? distances.get(edge.to)
          : Infinity;
        if (nextCost < existingCost) {
          distances.set(edge.to, nextCost);
          previous.set(edge.to, { from: node, edge: edge });
          heap.push(edge.to, nextCost);
        }
      }
    }

    var routes = new Map();
    state.stations.forEach(function (targetStation) {
      var bestNode = null;
      var bestCost = Infinity;

      targetStation.lines.forEach(function (lineId) {
        [1, -1].forEach(function (sign) {
          var key = nodeKey(lineId, targetStation.stationName, sign);
          var value = distances.get(key);
          if (value != null && value < bestCost) {
            bestCost = value;
            bestNode = key;
          }
        });
      });

      if (bestNode) {
        routes.set(
          targetStation.stationId,
          reconstructRoute(bestNode, distances.get(bestNode), previous)
        );
      }
    });

    return routes;
  }

  function reconstructRoute(targetNode, totalMinutes, previous) {
    var chain = [];
    var cursor = targetNode;

    while (cursor !== SOURCE_NODE && previous.has(cursor)) {
      var step = previous.get(cursor);
      chain.push(step);
      cursor = step.from;
    }
    chain.reverse();

    var backtrack = Boolean(chain[0] && chain[0].edge.meta.type === "start" && chain[0].edge.meta.reverse);
    var segments = [];
    var transfers = 0;

    chain.forEach(function (step) {
      var edge = step.edge;
      if (edge.meta.type === "ride") {
        var last = segments[segments.length - 1];
        if (last && last.lineId === edge.meta.lineId) {
          last.stops += 1;
        } else {
          segments.push({ lineId: edge.meta.lineId, stops: 1 });
        }
      } else if (edge.meta.type === "transfer") {
        // 支线贯通换乘配置为 0 分钟，不应在结果里显示成一次“换乘”。
        if (edge.meta.minutes > 0) transfers += 1;
      }
    });

    return {
      minutes: totalMinutes,
      segments: segments,
      transfers: transfers,
      backtrack: backtrack
    };
  }

  function MinHeap() {
    this.items = [];
  }

  MinHeap.prototype.size = 0;

  MinHeap.prototype.push = function (node, cost) {
    var item = { node: node, cost: cost };
    this.items.push(item);
    this.size = this.items.length;
    var index = this.items.length - 1;
    while (index > 0) {
      var parent = Math.floor((index - 1) / 2);
      if (this.items[parent].cost <= this.items[index].cost) break;
      var tmp = this.items[parent];
      this.items[parent] = this.items[index];
      this.items[index] = tmp;
      index = parent;
    }
  };

  MinHeap.prototype.pop = function () {
    var root = this.items[0];
    var last = this.items.pop();
    if (this.items.length && last) {
      this.items[0] = last;
      var index = 0;
      while (true) {
        var left = index * 2 + 1;
        var right = left + 1;
        var smallest = index;
        if (left < this.items.length && this.items[left].cost < this.items[smallest].cost) {
          smallest = left;
        }
        if (right < this.items.length && this.items[right].cost < this.items[smallest].cost) {
          smallest = right;
        }
        if (smallest === index) break;
        var tmp = this.items[index];
        this.items[index] = this.items[smallest];
        this.items[smallest] = tmp;
        index = smallest;
      }
    }
    this.size = this.items.length;
    return root;
  };

  /* ------------------------------------------------------------------
   * 查询与筛选
   * ------------------------------------------------------------------ */
  function parseDirection(value) {
    if (!value) return null;
    var parts = String(value).split("|");
    var lineId = parts[0];
    var sign = Number(parts[1]);
    if (!lineId || (sign !== 1 && sign !== -1)) return null;
    if (!state.lines[lineId]) return null;
    return { lineId: lineId, sign: sign };
  }

  function readFilters() {
    state.filters.inside = Boolean(dom.onlyInside.checked);
    state.filters.familyFacility = Boolean(dom.familyFacility.checked);
    state.filters.acceptTransfer = Boolean(dom.acceptTransfer.checked);
  }

  function runQuery() {
    readFilters();
    var station = state.stationById.get(state.currentStationId);
    var direction = state.direction;

    if (!station || !direction) {
      renderEmpty();
      return;
    }

    var cacheKey = station.stationId + "|" + direction.lineId + "|" + direction.sign;
    var routes = state.routeCache.get(cacheKey);
    if (!routes) {
      routes = computeRoutes(station, direction);
      state.routeCache.set(cacheKey, routes);
    }

    var results = [];
    state.stations.forEach(function (targetStation) {
      var route = routes.get(targetStation.stationId);
      if (!route) return;

      targetStation.toilets.forEach(function (toilet) {
        if (state.filters.inside && toilet.type !== "inside") return;
        if (
          state.filters.familyFacility &&
          !toilet.hasFamily &&
          !toilet.hasBabyCare
        ) {
          return;
        }
        if (!state.filters.acceptTransfer && route.transfers > 0) return;

        results.push({
          station: targetStation,
          toilet: toilet,
          route: route,
          roundedMinutes: Math.round(route.minutes)
        });
      });
    });

    results.sort(function (a, b) {
      if (a.route.minutes !== b.route.minutes) return a.route.minutes - b.route.minutes;
      var stationCompare = collator.compare(
        a.station.stationName,
        b.station.stationName
      );
      if (stationCompare !== 0) return stationCompare;
      if (a.toilet.type !== b.toilet.type) {
        return a.toilet.type === "inside" ? -1 : 1;
      }
      return collator.compare(a.toilet.id, b.toilet.id);
    });

    renderResults(results, station, direction);
  }

  function renderResults(results, station, direction) {
    dom.resultCount.textContent = String(results.length);
    dom.routeStatus.textContent =
      "从 " + station.stationName + " 出发 · " + getDirectionLabel(station, direction);

    if (!results.length) {
      renderEmpty(station, direction);
      return;
    }

    dom.resultSummary.textContent =
      "按预计到达时间升序 · 共 " +
      results.length +
      " 处 · " +
      (state.filters.acceptTransfer
        ? "换乘和反向乘车已计入"
        : "仅直达（不换乘）· 反向乘车已计入");

    dom.resultsList.innerHTML = results
      .map(function (result, index) {
        return buildResultCard(result, index === 0);
      })
      .join("");
    dom.resultsList.setAttribute("aria-busy", "false");
  }

  function getDirectionLabel(station, direction) {
    var line = state.lines[direction.lineId];
    var lineName = getLineName(direction.lineId);
    if (!line || !Array.isArray(line.stations)) return lineName;

    var index = line.stations.indexOf(station.stationName);
    if (index === -1) return lineName;

    var destination =
      direction.sign === 1
        ? line.stations[line.stations.length - 1]
        : line.stations[0];

    return lineName + " · 往" + destination + "方向";
  }

  function buildResultCard(result, isFastest) {
    var station = result.station;
    var toilet = result.toilet;
    var route = result.route;
    var lineBadges = station.lines
      .map(function (lineId) {
        return (
          '<span class="line-pill" style="--line-color:' +
          escapeAttr(getLineColor(lineId)) +
          '">' +
          escapeHtml(getLineName(lineId)) +
          "</span>"
        );
      })
      .join("");

    var features = [];
    if (toilet.hasFamily) features.push("家庭卫生间");
    if (toilet.hasBabyCare) features.push("母婴室");
    if (toilet.accessible) features.push("无障碍");
    var featureHtml = features
      .map(function (feature) {
        return '<span class="feature-pill">' + escapeHtml(feature) + "</span>";
      })
      .join("");
    if (!toilet.hasFamily && !toilet.hasBabyCare) {
      featureHtml +=
        '<span class="feature-pill feature-pill--muted">家庭/母婴设施以现场为准</span>';
    }
    if (!featureHtml) {
      featureHtml =
        '<span class="feature-pill feature-pill--muted">设施信息以现场为准</span>';
    }

    var routeHtml = buildRouteHtml(route);
    var typeLabel = toilet.type === "inside" ? "站内" : "站外";
    var note = toilet.note || "以现场为准";

    return (
      '<li class="toilet-card' +
      (isFastest ? " is-fastest" : "") +
      '">' +
      '<div class="toilet-card__top">' +
      '<div class="toilet-card__heading">' +
      (isFastest ? '<span class="fastest-badge">最快</span>' : "") +
      '<div class="line-pills">' +
      lineBadges +
      "</div>" +
      "<h3>" +
      escapeHtml(station.stationName) +
      "</h3>" +
      "</div>" +
      '<div class="eta" aria-label="预计到达时间">' +
      '<span class="eta__label">预计到达</span>' +
      '<strong>约 ' +
      result.roundedMinutes +
      " 分钟</strong>" +
      '<span class="eta__estimate">（估算）</span>' +
      "</div>" +
      "</div>" +
      '<div class="toilet-card__location">' +
      '<span class="type-badge type-badge--' +
      toilet.type +
      '">' +
      typeLabel +
      "</span>" +
      "<p>" +
      escapeHtml(toilet.location || "位置暂无") +
      "</p>" +
      "</div>" +
      '<div class="feature-row">' +
      featureHtml +
      (toilet.nearExit
        ? '<span class="exit-note">靠近 ' + escapeHtml(toilet.nearExit) + "</span>"
        : "") +
      "</div>" +
      '<div class="route-strip">' +
      '<span class="route-strip__label">路线</span>' +
      "<span>" +
      routeHtml +
      "</span>" +
      "</div>" +
      '<div class="toilet-card__foot">' +
      "<span>" +
      escapeHtml(note) +
      "</span>" +
      '<span class="honesty-note">时间为估算，不含站内步行与候车</span>' +
      "</div>" +
      "</li>"
    );
  }

  function buildRouteHtml(route) {
    if (!route.segments.length) return "当前站";

    var parts = route.segments.map(function (segment) {
      return (
        '<span class="route-line" style="--line-color:' +
        escapeAttr(getLineColor(segment.lineId)) +
        '">' +
        escapeHtml(getLineName(segment.lineId)) +
        "</span> " +
        segment.stops +
        " 站"
      );
    });
    var html = parts.join(' <span class="route-arrow">→</span> ');
    if (route.transfers > 0) {
      html += " · 换乘 " + route.transfers + " 次";
    } else {
      html += " · 直达";
    }
    if (route.backtrack) {
      html += " · 往回坐 +" + BACKTRACK_MINUTES + " 分钟";
    }
    return html;
  }

  function renderEmpty(station, direction) {
    dom.resultCount.textContent = "0";
    if (station && direction) {
      dom.routeStatus.textContent =
        "从 " + station.stationName + " 出发 · " + getDirectionLabel(station, direction);
    }
    dom.resultSummary.textContent = "当前条件下没有可用厕所，试试放宽筛选。";
    dom.resultsList.innerHTML =
      '<li class="toilet-empty">' +
      '<p class="toilet-empty__eyebrow">NO MATCH</p>' +
      "<h3>当前条件下没有可用厕所</h3>" +
      "<p>试试放宽筛选，或换一个当前站点。</p>" +
      "</li>";
    dom.resultsList.setAttribute("aria-busy", "false");
  }

  function showLoading() {
    dom.loading.hidden = false;
    dom.error.hidden = true;
    dom.resultsList.setAttribute("aria-busy", "true");
    dom.resultsList.innerHTML =
      '<li class="toilet-skeleton" aria-hidden="true"><span></span><span></span><span></span></li>' +
      '<li class="toilet-skeleton" aria-hidden="true"><span></span><span></span><span></span></li>';
  }

  function showError(message) {
    dom.loading.hidden = true;
    dom.error.hidden = false;
    dom.error.querySelector("[data-error-message]").textContent =
      "数据加载失败：" + (message || "请稍后重试");
    dom.resultsList.innerHTML = "";
    dom.resultsList.setAttribute("aria-busy", "false");
    dom.resultCount.textContent = "—";
    dom.resultSummary.textContent = "无法读取 toilets.json / lines.json / transfers.json。";
  }

  function escapeHtml(value) {
    return String(value == null ? "" : value).replace(/[&<>"']/g, function (character) {
      return {
        "&": "&amp;",
        "<": "&lt;",
        ">": "&gt;",
        '"': "&quot;",
        "'": "&#39;"
      }[character];
    });
  }

  function escapeAttr(value) {
    return escapeHtml(value);
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
