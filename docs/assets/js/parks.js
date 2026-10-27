/**
 * 上海公园地图页（高德地图 JavaScript API 2.0）
 * ------------------------------------------------------------------
 * 坐标说明：
 * - parks.json 中的 lat/lng 已统一为高德 GCJ-02 坐标（通过高德坐标拾取器更新），
 *   加载后直接用于高德 Marker / Circle / Haversine 距离，不再做二次转换。
 * - AMap.Geolocation 返回的坐标同样是 GCJ-02，直接使用。
 *
 * 安全说明：
 * - Key 与 securityJsCode 位于 parks/index.html，纯静态站无法隐藏前端密钥；
 *   仅限个人非商业项目使用，并应在高德控制台配置安全域名与配额。
 *
 * 手机适配关键处理：
 * 1. 初始化时检测 768px 断点，手机 zoom 12（桌面 11）。
 * 2. 列表随地图联动：点击列表项 → setZoom/setCenter + 打开高德信息窗体；
 *    点击 marker → 列表同步高亮并滚动到可见位置。
 * 3. 定位按钮位于地图右下角；定位失败只影响距离排序，不阻断地图与列表。
 * 4. 详情使用原生 <dialog>；高德信息窗体使用 isCustom 卡片。
 * 5. 列表滚动使用原生 overflow-y + overscroll-behavior。
 *
 * 数据流：fetch parks.json → normalize（GCJ-02 直接使用）→ filter → sort（名称 / Haversine 距离）
 *        → 同步渲染列表与高德 Marker。
 */
(function () {
  "use strict";

  var EARTH_RADIUS_KM = 6371;
  var MOBILE_QUERY = "(max-width: 768px)";
  var SEARCH_DEBOUNCE = 120;
  var FILTER_TAGS = [
    "动物园",
    "植物园",
    "森林公园",
    "郊野公园",
    "滨江绿地",
    "历史名园",
    "综合公园",
    "社区公园",
    "口袋公园",
    "古典园林",
    "湿地公园",
    "水域",
    "露营",
    "烧烤",
    "沙滩",
    "樱花",
    "亲子"
  ];

  var state = {
    parks: [],
    markers: new Map(),
    selectedId: null,
    query: "",
    activeTags: new Set(),
    sortMode: "name",
    userLocation: null,
    locationState: "idle",
    popupTimer: null
  };

  var dom = {};
  var map = null;
  var infoWindow = null;
  var userMarker = null;
  var userAccuracyCircle = null;
  var geolocationInstance = null;
  var visibleMarkerIds = new Set();
  var mapReady = false;
  var resizeTimer = null;
  var searchTimer = null;
  var toastTimer = null;
  var toastRemoveTimer = null;
  var lastFocusedElement = null;
  var prefersReducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)");

  var nameCollator = new Intl.Collator("zh-Hans-CN", {
    numeric: true,
    sensitivity: "base"
  });

  /* ------------------------------------------------------------------
   * 初始化
   * ------------------------------------------------------------------ */
  function init() {
    cacheDom();
    bindEvents();
    setControlsDisabled(true);
    initMap();
    loadParks();
  }

  function cacheDom() {
    function byId(id) {
      return document.getElementById(id);
    }

    dom.mapCanvas = byId("map");
    dom.mapPanel = document.querySelector(".map-panel");
    dom.mapLoading = byId("map-loading");
    dom.search = byId("park-search");
    dom.clearSearch = byId("clear-search");
    dom.tagList = byId("tag-list");
    dom.sortSelect = byId("sort-select");
    dom.resetFilters = byId("reset-filters");
    dom.parkList = byId("park-list");
    dom.resultCount = byId("result-count");
    dom.totalCount = byId("total-count");
    dom.locationStatus = byId("location-status");
    dom.locateButton = byId("locate-button");
    dom.showAll = byId("show-all");
    dom.zoomIn = byId("zoom-in");
    dom.zoomOut = byId("zoom-out");
    dom.toast = byId("toast");
    dom.toastMessage = byId("toast-message");
    dom.detailDialog = byId("detail-dialog");
    dom.detailContent = byId("detail-content");
    dom.detailClose = byId("detail-close");
  }

  function bindEvents() {
    dom.search.addEventListener("input", handleSearchInput);
    dom.search.addEventListener("keydown", function (event) {
      if (event.key === "Escape" && dom.search.value) {
        event.preventDefault();
        clearSearch();
      }
    });
    dom.clearSearch.addEventListener("click", clearSearch);
    dom.tagList.addEventListener("click", handleTagClick);
    dom.tagList.addEventListener("wheel", handleTagWheel, { passive: false });
    dom.sortSelect.addEventListener("change", handleSortChange);
    dom.resetFilters.addEventListener("click", resetFilters);
    dom.locateButton.addEventListener("click", locateUser);
    dom.showAll.addEventListener("click", fitAllVisibleParks);
    dom.zoomIn.addEventListener("click", function () {
      if (map) map.zoomIn();
    });
    dom.zoomOut.addEventListener("click", function () {
      if (map) map.zoomOut();
    });
    dom.parkList.addEventListener("click", handleParkListClick);

    dom.detailClose.addEventListener("click", closeDetail);
    dom.detailDialog.addEventListener("click", function (event) {
      // 点击 dialog 的透明遮罩区域关闭；点击卡片内部不会触发。
      if (event.target === dom.detailDialog) closeDetail();
    });
    dom.detailDialog.addEventListener("close", handleDetailClosed);

    document.addEventListener("click", handleDocumentClick);

    window.addEventListener("resize", function () {
      window.clearTimeout(resizeTimer);
      resizeTimer = window.setTimeout(function () {
        if (map && typeof map.resize === "function") map.resize();
      }, 150);
    });
  }

  /* ------------------------------------------------------------------
   * 高德地图初始化
   * - 高德 JS API 通过 parks/index.html 的 <script> 引入。
   * - 坐标系顺序是 [经度, 纬度]；海拔/缩放等配置保持与之前一致。
   * ------------------------------------------------------------------ */
  function initMap() {
    if (!window.AMap) {
      showMapUnavailable();
      showToast("高德地图 API 加载失败，仍可浏览公园列表", "error", 5200);
      return;
    }

    var isMobile = window.matchMedia(MOBILE_QUERY).matches;

    map = new window.AMap.Map("map", {
      zoom: isMobile ? 12 : 11,
      center: [121.47, 31.23],
      viewMode: "2D",
      resizeEnable: true,
      dragEnable: true,
      zoomEnable: true,
      rotateEnable: false,
      pitchEnable: false,
      doubleClickZoom: true,
      scrollWheel: true,
      keyboardEnable: true,
      showLabel: true
    });

    // 必须包含 point，否则高德不会绘制 POI 点位与地点名称（放大后也一直空白）。
    if (typeof map.setFeatures === "function") {
      map.setFeatures(["bg", "road", "point"]);
    }

    // 临时调试句柄：?debug=1 时可在控制台检查地图尺寸和中心点。
    if (new URLSearchParams(window.location.search).get("debug") === "1") {
      window.__parksMap = map;
    }

    infoWindow = new window.AMap.InfoWindow({
      isCustom: true,
      autoMove: true,
      offset: new window.AMap.Pixel(0, -50)
    });

    infoWindow.on("open", function () {
      if (dom.mapPanel) dom.mapPanel.classList.add("has-popup");
    });

    infoWindow.on("close", function () {
      if (dom.mapPanel) dom.mapPanel.classList.remove("has-popup");
    });

    map.on("complete", function () {
      mapReady = true;
      hideMapLoading();
      if (map && typeof map.resize === "function") map.resize();
    });

    // 移动端地址栏出现/隐藏后，容器尺寸可能变化，主动通知高德重算。
    window.setTimeout(function () {
      if (map && typeof map.resize === "function") map.resize();
    }, 0);
  }

  function hideMapLoading() {
    if (!dom.mapLoading) return;
    dom.mapLoading.classList.add("is-hidden");
  }

  function showMapUnavailable() {
    hideMapLoading();
    if (dom.zoomIn) dom.zoomIn.disabled = true;
    if (dom.zoomOut) dom.zoomOut.disabled = true;
    if (!dom.mapCanvas) return;
    dom.mapCanvas.innerHTML =
      '<div class="map-fallback">' +
      '<p>地图暂时无法显示</p>' +
      '<span>请检查网络或高德 Key 配置后刷新页面，公园列表与详情仍可正常使用。</span>' +
      "</div>";
  }

  /* ------------------------------------------------------------------
   * 数据加载与规范化
   * ------------------------------------------------------------------ */
  function loadParks() {
    dom.parkList.setAttribute("aria-busy", "true");
    dom.parkList.innerHTML =
      '<div class="skeleton-card" aria-hidden="true"><span></span><span></span><span></span></div>' +
      '<div class="skeleton-card" aria-hidden="true"><span></span><span></span><span></span></div>' +
      '<div class="skeleton-card" aria-hidden="true"><span></span><span></span><span></span></div>';

    fetch(new URL("data/parks.json", document.baseURI).href, { cache: "no-cache" })
      .then(function (response) {
        if (!response.ok) throw new Error("HTTP " + response.status);
        return response.json();
      })
      .then(function (rawParks) {
        if (!Array.isArray(rawParks)) {
          throw new Error("parks.json 必须是数组");
        }

        var seen = new Set();
        var normalized = [];

        rawParks.forEach(function (rawPark) {
          var park = normalizePark(rawPark);
          if (!park || seen.has(park.id)) return;
          seen.add(park.id);
          normalized.push(park);
        });

        if (!normalized.length) {
          throw new Error("parks.json 中没有有效公园记录");
        }

        state.parks = normalized;
        dom.totalCount.textContent = String(normalized.length);
        renderTagFilters();
        setControlsDisabled(false);
        updateDistanceOption();
        createParkMarkers();
        applyFilters({ resetScroll: true });
        hideMapLoading();

        restoreDetailFromUrl();
        showToast("已收录 " + normalized.length + " 处上海绿地", "success", 2600);
      })
      .catch(function (error) {
        console.error("公园数据加载失败：", error);
        showDataError();
      });
  }

  /**
   * 容错处理：字段缺失、坐标非法都只跳过该条记录，不让整页崩溃。
   */
  function normalizePark(raw) {
    if (!raw || typeof raw !== "object") return null;

    var id = String(raw.id || "").trim();
    var name = String(raw.name || "").trim();
    var lat = Number(raw.lat);
    var lng = Number(raw.lng);

    if (
      !id ||
      !name ||
      !Number.isFinite(lat) ||
      !Number.isFinite(lng) ||
      lat < -90 ||
      lat > 90 ||
      lng < -180 ||
      lng > 180
    ) {
      console.warn("已跳过无效公园记录：", raw);
      return null;
    }

    var tags = Array.isArray(raw.tags)
      ? Array.from(
          new Set(
            raw.tags
              .map(function (tag) {
                return String(tag || "").trim();
              })
              .filter(Boolean)
          )
        )
      : [];

    // parks.json 已使用高德坐标拾取器的 GCJ-02 坐标；直接交给高德地图与距离计算。
    return {
      id: id,
      name: name,
      englishName: stringValue(raw.englishName),
      district: stringValue(raw.district),
      address: stringValue(raw.address),
      lat: lat,
      lng: lng,
      area: stringValue(raw.area),
      hours: stringValue(raw.hours),
      history: stringValue(raw.history),
      highlight: stringValue(raw.highlight),
      tags: tags
    };
  }

  function stringValue(value) {
    return value == null ? "" : String(value).trim();
  }

  function showDataError() {
    dom.parkList.setAttribute("aria-busy", "false");
    dom.resultCount.textContent = "0";
    dom.totalCount.textContent = "0";
    dom.tagList.innerHTML = '<span class="tag-placeholder">标签暂不可用</span>';
    dom.parkList.innerHTML =
      '<div class="list-empty" role="status">' +
      '<svg width="34" height="34" viewBox="0 0 34 34" aria-hidden="true">' +
      '<path d="M17 4 31 30H3L17 4Z" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"/>' +
      '<path d="M17 13v7M17 25v.2" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/>' +
      "</svg>" +
      "<h3>公园数据暂时走丢了</h3>" +
      "<p>请检查网络连接后重试。地图仍可缩放浏览。</p>" +
      '<button type="button" data-retry-parks>重新加载数据</button>' +
      "</div>";
    hideMapLoading();
    showToast("公园数据加载失败，请稍后重试", "error", 5200);
  }

  /* ------------------------------------------------------------------
   * 标签与控件初始化
   * ------------------------------------------------------------------ */
  function renderTagFilters() {
    var available = FILTER_TAGS.filter(function (tag) {
      return state.parks.some(function (park) {
        return park.tags.indexOf(tag) !== -1;
      });
    });

    if (!available.length) {
      dom.tagList.innerHTML = '<span class="tag-placeholder">暂无标签可筛选</span>';
      return;
    }

    dom.tagList.innerHTML = available
      .map(function (tag) {
        return (
          '<button class="tag-chip" type="button" data-tag="' +
          escapeAttr(tag) +
          '" aria-pressed="false">' +
          escapeHtml(tag) +
          "</button>"
        );
      })
      .join("");
  }

  function setControlsDisabled(disabled) {
    dom.search.disabled = disabled;
    dom.sortSelect.disabled = disabled;
    dom.resetFilters.disabled = true;
    dom.clearSearch.hidden = true;
  }

  function updateDistanceOption() {
    var option = dom.sortSelect.querySelector('option[value="distance"]');
    if (!option) return;
    option.disabled = !state.userLocation;
    option.textContent = state.userLocation ? "按距离排序" : "按距离排序（需定位）";
    if (!state.userLocation && state.sortMode === "distance") {
      state.sortMode = "name";
      dom.sortSelect.value = "name";
    }
  }

  /* ------------------------------------------------------------------
   * 搜索与标签筛选
   * ------------------------------------------------------------------ */
  function handleSearchInput() {
    state.query = dom.search.value;
    dom.clearSearch.hidden = state.query.length === 0;
    window.clearTimeout(searchTimer);
    searchTimer = window.setTimeout(function () {
      applyFilters({ fitMap: true, resetScroll: true });
    }, SEARCH_DEBOUNCE);
  }

  function clearSearch() {
    window.clearTimeout(searchTimer);
    state.query = "";
    dom.search.value = "";
    dom.clearSearch.hidden = true;
    applyFilters({ fitMap: true, resetScroll: true });
    dom.search.focus();
  }

  function handleTagClick(event) {
    var chip = event.target.closest(".tag-chip");
    if (!chip) return;

    var tag = chip.getAttribute("data-tag");
    if (!tag) return;

    if (state.activeTags.has(tag)) {
      state.activeTags.delete(tag);
    } else {
      state.activeTags.add(tag);
    }

    chip.setAttribute("aria-pressed", String(state.activeTags.has(tag)));
    applyFilters({ fitMap: true, resetScroll: true });
  }

  /**
   * 桌面端标签是一行横向滚动区域。让鼠标滚轮在标签上也能横向浏览，
   * 比只依赖 Shift + 滚轮 / 触控板更直观；手机端触控滑动不受影响。
   */
  function handleTagWheel(event) {
    if (Math.abs(event.deltaY) <= Math.abs(event.deltaX)) return;

    var maxScroll = dom.tagList.scrollWidth - dom.tagList.clientWidth;
    if (maxScroll <= 1) return;

    var atStart = dom.tagList.scrollLeft <= 0;
    var atEnd = dom.tagList.scrollLeft >= maxScroll - 1;
    if ((event.deltaY > 0 && atEnd) || (event.deltaY < 0 && atStart)) return;

    event.preventDefault();
    dom.tagList.scrollLeft = Math.max(
      0,
      Math.min(maxScroll, dom.tagList.scrollLeft + event.deltaY)
    );
  }

  function syncTagChips() {
    var chips = dom.tagList.querySelectorAll(".tag-chip");
    chips.forEach(function (chip) {
      var tag = chip.getAttribute("data-tag");
      chip.setAttribute("aria-pressed", String(state.activeTags.has(tag)));
    });
  }

  function resetFilters() {
    window.clearTimeout(searchTimer);
    state.query = "";
    state.activeTags.clear();
    dom.search.value = "";
    dom.clearSearch.hidden = true;
    state.sortMode = "name";
    dom.sortSelect.value = "name";
    syncTagChips();
    applyFilters({ fitMap: true, resetScroll: true });
  }

  function hasActiveFilters() {
    return Boolean(state.query.trim()) || state.activeTags.size > 0 || state.sortMode !== "name";
  }

  function updateResetState() {
    dom.resetFilters.disabled = !hasActiveFilters();
  }

  /**
   * 名称/关键词与标签是 AND 关系；多个标签之间取并集（OR）。
   * 这样同时选择“动物园”和“植物园”时，可以看到两类场所，而不是空结果。
   */
  function getFilteredParks() {
    var query = normalizeText(state.query.trim());
    var activeTags = Array.from(state.activeTags);

    return state.parks.filter(function (park) {
      var haystack = normalizeText(
        [
          park.name,
          park.englishName,
          park.district,
          park.address,
          park.highlight,
          park.history,
          park.tags.join(" ")
        ].join(" ")
      );

      var matchesQuery = !query || haystack.indexOf(query) !== -1;
      var matchesTags =
        activeTags.length === 0 ||
        activeTags.some(function (tag) {
          return park.tags.indexOf(tag) !== -1;
        });

      return matchesQuery && matchesTags;
    });
  }

  function normalizeText(value) {
    return String(value || "")
      .toLowerCase()
      .normalize("NFKC");
  }

  /**
   * 主渲染入口：先渲染列表，再同步 marker，保证两边的筛选结果完全一致。
   */
  function applyFilters(options) {
    options = options || {};
    var filtered = getFilteredParks();

    if (
      state.selectedId &&
      !filtered.some(function (park) {
        return park.id === state.selectedId;
      })
    ) {
      state.selectedId = null;
      closeInfoWindow();
    }

    renderList(filtered, options);
    renderMarkers(filtered);
    updateResultSummary(filtered.length);
    updateResetState();

    if (options.fitMap && filtered.length) {
      fitParksInView(filtered);
    }
  }

  function updateResultSummary(count) {
    dom.resultCount.textContent = String(count);
    dom.parkList.setAttribute("aria-busy", "false");
  }

  function renderList(parks, options) {
    options = options || {};

    if (!parks.length) {
      dom.parkList.innerHTML =
        '<div class="list-empty" role="listitem">' +
        '<svg width="38" height="38" viewBox="0 0 38 38" aria-hidden="true">' +
        '<circle cx="17" cy="17" r="10" fill="none" stroke="currentColor" stroke-width="1.6"/>' +
        '<path d="m25 25 8 8M13 17h8" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/>' +
        "</svg>" +
        "<h3>没有找到匹配的公园</h3>" +
        "<p>换一个关键词，或清除部分标签。地图仍可自由缩放浏览。</p>" +
        '<button type="button" data-empty-reset>清除筛选</button>' +
        "</div>";
      dom.parkList.setAttribute("aria-busy", "false");
      return;
    }

    var sortedParks = sortParks(parks);

    dom.parkList.innerHTML = sortedParks
      .map(function (park, index) {
        return buildParkCard(park, index);
      })
      .join("");

    dom.parkList.setAttribute("aria-busy", "false");

    if (options.resetScroll) {
      dom.parkList.scrollTop = 0;
    }

    highlightSelectedCard(false);
  }

  /**
   * 默认按中文名称排序；定位成功后允许按 Haversine 直线距离升序。
   */
  function sortParks(parks) {
    var result = parks.slice();

    if (state.sortMode === "distance" && state.userLocation) {
      result.sort(function (a, b) {
        return getDistanceKm(state.userLocation, a) - getDistanceKm(state.userLocation, b);
      });
      return result;
    }

    result.sort(function (a, b) {
      return nameCollator.compare(a.name, b.name);
    });
    return result;
  }

  function handleSortChange() {
    var mode = dom.sortSelect.value;

    if (mode === "distance" && !state.userLocation) {
      dom.sortSelect.value = state.sortMode;
      showToast("定位后才能按距离排序", "error");
      return;
    }

    state.sortMode = mode;
    renderList(getFilteredParks(), { resetScroll: true });
    updateResetState();
  }

  function buildParkCard(park, index) {
    var distance = getDistanceText(park);
    var distanceKm = getDistanceKm(state.userLocation, park);
    var primaryType = park.tags[0] || "城市绿地";
    var subtitle = [park.district || "上海", primaryType].join(" · ");
    var tags = park.tags.slice(0, 2);
    var extraTagCount = Math.max(0, park.tags.length - tags.length);
    var tagsHtml = tags
      .map(function (tag) {
        return '<span class="park-tag">' + escapeHtml(tag) + "</span>";
      })
      .join("");
    if (extraTagCount > 0) {
      tagsHtml += '<span class="park-tag">+' + extraTagCount + "</span>";
    }

    var ariaDistance = distance
      ? "，直线距离约 " + formatDistanceSpoken(distanceKm)
      : "";
    var selected = park.id === state.selectedId;
    var ariaLabel =
      "查看 " +
      park.name +
      " 在地图上的位置" +
      ariaDistance +
      "。所在区域：" +
      (park.district || "上海") +
      "。";

    return (
      '<li class="park-list__item" role="listitem">' +
      '<button class="park-card' +
      (selected ? " is-selected" : "") +
      '" type="button" data-park-id="' +
      escapeAttr(park.id) +
      '" aria-label="' +
      escapeAttr(ariaLabel) +
      '"' +
      (selected ? ' aria-current="true"' : "") +
      ">" +
      '<span class="park-card__top">' +
      '<span class="park-index" aria-hidden="true">' +
      String(index + 1).padStart(2, "0") +
      "</span>" +
      '<span class="park-card__main">' +
      '<span class="park-name-row">' +
      '<span class="park-name">' +
      escapeHtml(park.name) +
      "</span>" +
      (distance
        ? '<span class="park-distance" title="与你的直线距离">' + escapeHtml(distance) + "</span>"
        : "") +
      "</span>" +
      '<span class="park-subtitle">' +
      escapeHtml(subtitle) +
      "</span>" +
      "</span>" +
      "</span>" +
      '<span class="park-highlight">' +
      escapeHtml(park.highlight || "暂无简介，点击在地图上查看位置。") +
      "</span>" +
      '<span class="park-card__foot">' +
      '<span class="park-tags">' +
      tagsHtml +
      "</span>" +
      '<span class="park-area">' +
      escapeHtml(park.area || "面积暂无") +
      "</span>" +
      "</span>" +
      "</button>" +
      "</li>"
    );
  }

  function handleParkListClick(event) {
    var card = event.target.closest(".park-card");
    if (!card) return;
    var parkId = card.getAttribute("data-park-id");
    if (!parkId) return;
    focusPark(parkId, { fromList: true });
  }

  /* ------------------------------------------------------------------
   * 高德 Marker 与信息窗体
   * ------------------------------------------------------------------ */
  function createParkMarkers() {
    if (!map || !window.AMap) return;

    closeInfoWindow();
    state.markers.forEach(function (marker) {
      map.remove(marker);
    });
    state.markers.clear();
    visibleMarkerIds.clear();

    state.parks.forEach(function (park) {
      var marker = new window.AMap.Marker({
        position: [park.lng, park.lat],
        content: buildMarkerContent(false),
        offset: new window.AMap.Pixel(-22, -42),
        title: park.name,
        zIndex: 100,
        extData: { parkId: park.id }
      });

      marker.on("click", function () {
        state.selectedId = park.id;
        updateMarkerHighlight();
        highlightSelectedCard(true);
        openParkInfo(park, marker);
      });

      state.markers.set(park.id, marker);
    });
  }

  /**
   * 筛选时只增删需要显示的高德 Marker，不重建整个 marker 集合。
   */
  function renderMarkers(parks) {
    if (!map || !window.AMap) return;

    window.clearTimeout(state.popupTimer);
    closeInfoWindow();

    var visibleIds = new Set(
      parks.map(function (park) {
        return park.id;
      })
    );

    state.markers.forEach(function (marker, id) {
      var shouldShow = visibleIds.has(id);
      var isVisible = visibleMarkerIds.has(id);

      if (shouldShow && !isVisible) {
        map.add(marker);
        visibleMarkerIds.add(id);
      } else if (!shouldShow && isVisible) {
        map.remove(marker);
        visibleMarkerIds.delete(id);
      }
    });

    updateMarkerHighlight();
  }

  function buildMarkerContent(active) {
    var className = "park-marker" + (active ? " is-active" : "");
    return (
      '<div class="' +
      className +
      '">' +
      '<svg viewBox="0 0 32 42" aria-hidden="true" focusable="false">' +
      '<path d="M16 1C7.7 1 1 7.7 1 16c0 11 15 24.5 15 24.5S31 27 31 16C31 7.7 24.3 1 16 1Z" fill="currentColor" stroke="#f7f2e7" stroke-width="2"/>' +
      '<circle cx="16" cy="16" r="4.6" fill="#f7f2e7"/>' +
      "</svg>" +
      "</div>"
    );
  }

  function updateMarkerHighlight() {
    state.markers.forEach(function (marker, id) {
      var isActive = id === state.selectedId;
      marker.setContent(buildMarkerContent(isActive));
      if (typeof marker.setzIndex === "function") {
        marker.setzIndex(isActive ? 220 : 100);
      }
    });
  }

  function openParkInfo(park, marker) {
    if (!map || !infoWindow || !marker) return;

    infoWindow.setContent(buildPopupHtml(park));
    if (dom.mapPanel) dom.mapPanel.classList.add("has-popup");
    infoWindow.open(map, marker.getPosition());
  }

  function closeInfoWindow() {
    if (infoWindow) infoWindow.close();
    if (dom.mapPanel) dom.mapPanel.classList.remove("has-popup");
  }

  function buildPopupHtml(park) {
    var distance = getDistanceText(park);
    var tags = park.tags.slice(0, 4);
    var tagsHtml = tags
      .map(function (tag) {
        return '<span class="popup-tag">' + escapeHtml(tag) + "</span>";
      })
      .join("");

    return (
      '<article class="map-popup">' +
      '<button class="map-popup__close" type="button" data-close-info aria-label="关闭公园简介">' +
      '<svg width="18" height="18" viewBox="0 0 18 18" aria-hidden="true">' +
      '<path d="m4 4 10 10M14 4 4 14" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/>' +
      "</svg>" +
      "</button>" +
      '<p class="map-popup__eyebrow">' +
      escapeHtml((park.district || "上海") + " · " + (park.tags[0] || "城市绿地")) +
      "</p>" +
      "<h3>" +
      escapeHtml(park.name) +
      "</h3>" +
      '<p class="map-popup__highlight">' +
      escapeHtml(park.highlight || "暂无简介") +
      "</p>" +
      '<div class="map-popup__tags">' +
      tagsHtml +
      "</div>" +
      '<div class="map-popup__meta">' +
      "<span>" +
      escapeHtml(park.area || "面积暂无") +
      "</span>" +
      "<span>" +
      escapeHtml(park.hours || "时间暂无") +
      "</span>" +
      "</div>" +
      (distance
        ? '<p class="map-popup__distance">距你 ' + escapeHtml(distance) + "（直线）</p>"
        : "") +
      '<button class="popup-detail-button" type="button" data-open-park="' +
      escapeAttr(park.id) +
      '">查看详情' +
      '<svg width="15" height="15" viewBox="0 0 15 15" aria-hidden="true">' +
      '<path d="M3 7.5h9M8 3l4.5 4.5L8 12" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/>' +
      "</svg>" +
      "</button>" +
      "</article>"
    );
  }

  /* ------------------------------------------------------------------
   * 列表 ↔ 地图联动
   * ------------------------------------------------------------------ */
  function focusPark(parkId, options) {
    options = options || {};
    var park = findPark(parkId);
    if (!park) return;

    state.selectedId = park.id;
    updateMarkerHighlight();
    highlightSelectedCard(true);

    if (!map || !state.markers.has(park.id)) {
      // 地图不可用时，点击列表直接打开详情，保证核心内容可访问。
      openDetail(park.id);
      return;
    }

    closeInfoWindow();
    var marker = state.markers.get(park.id);

    if (options.fly !== false) {
      // 高德 API 坐标系顺序为 [经度, 纬度]；与需求一致，点击列表项缩放到 15 级。
      map.setZoom(15);
      map.setCenter([park.lng, park.lat]);
    }

    if (options.openDetail) {
      openDetail(park.id);
      return;
    }

    if (options.openPopup === false) return;

    window.clearTimeout(state.popupTimer);
    var delay = options.fly === false ? 20 : prefersReducedMotion.matches ? 80 : 360;
    state.popupTimer = window.setTimeout(function () {
      openParkInfo(park, marker);
    }, delay);
  }

  function highlightSelectedCard(shouldScroll) {
    var selectedCard = null;
    var cards = dom.parkList.querySelectorAll(".park-card");

    cards.forEach(function (card) {
      var isSelected = card.getAttribute("data-park-id") === state.selectedId;
      card.classList.toggle("is-selected", isSelected);
      if (isSelected) {
        card.setAttribute("aria-current", "true");
        selectedCard = card;
      } else {
        card.removeAttribute("aria-current");
      }
    });

    if (selectedCard && shouldScroll) {
      selectedCard.scrollIntoView({
        block: "nearest",
        inline: "nearest",
        behavior: prefersReducedMotion.matches ? "auto" : "smooth"
      });
    }
  }

  function fitAllVisibleParks() {
    var visible = getFilteredParks();
    if (!visible.length) {
      showToast("当前没有可显示的公园", "error");
      return;
    }
    if (!map) {
      showToast("地图暂不可用，无法全览", "error");
      return;
    }
    fitParksInView(visible);
  }

  function fitParksInView(parks) {
    if (!map || !window.AMap || !parks.length) return;

    closeInfoWindow();
    var markers = parks
      .map(function (park) {
        return state.markers.get(park.id);
      })
      .filter(Boolean);

    if (!markers.length) return;

    if (markers.length === 1) {
      map.setZoom(15);
      map.setCenter([parks[0].lng, parks[0].lat]);
      return;
    }

    if (typeof map.setFitView === "function") {
      map.setFitView(markers, false, [60, 60, 60, 60], 13);
    }
  }

  function findPark(parkId) {
    return state.parks.find(function (park) {
      return park.id === parkId;
    });
  }

  /* ------------------------------------------------------------------
   * 定位与 Haversine 距离
   * ------------------------------------------------------------------ */
  function locateUser() {
    if (state.locationState === "pending") return;

    state.locationState = "pending";
    setLocationPending(true);
    setLocationStatus("pending", "正在通过高德定位…");
    dom.locateButton.disabled = true;

    ensureGeolocation()
      .then(function (geo) {
        try {
          geo.getCurrentPosition();
        } catch (error) {
          handleLocationError(error, "geo");
        }
      })
      .catch(function (error) {
        handleLocationError(error, "plugin");
      });
  }

  /**
   * 按需加载 AMap.Geolocation 插件。
   * 插件返回的坐标已经是 GCJ-02，后续直接用于地图和距离计算，不再 convertFrom。
   */
  function ensureGeolocation() {
    if (geolocationInstance) return Promise.resolve(geolocationInstance);
    if (!window.AMap) return Promise.reject({ info: "AMAP_NOT_READY" });

    return new Promise(function (resolve, reject) {
      var settled = false;
      var timer = window.setTimeout(function () {
        if (settled) return;
        settled = true;
        reject({ info: "PLUGIN_TIMEOUT" });
      }, 12000);

      function finish(callback, value) {
        if (settled) return;
        settled = true;
        window.clearTimeout(timer);
        callback(value);
      }

      function create() {
        if (settled) return;

        if (!window.AMap.Geolocation) {
          finish(reject, { info: "PLUGIN_UNAVAILABLE" });
          return;
        }

        geolocationInstance = new window.AMap.Geolocation({
          enableHighAccuracy: true,
          timeout: 15000,
          maximumAge: 0,
          needAddress: false,
          showButton: false,
          showMarker: false,
          showCircle: false,
          panToLocation: false,
          zoomToAccuracy: false
        });

        geolocationInstance.on("complete", handleAmapLocationSuccess);
        geolocationInstance.on("error", handleAmapLocationError);
        finish(resolve, geolocationInstance);
      }

      if (window.AMap.Geolocation) {
        create();
        return;
      }

      try {
        window.AMap.plugin("AMap.Geolocation", create);
      } catch (error) {
        finish(reject, error);
      }
    });
  }

  function setLocationPending(isPending) {
    var label = dom.locateButton.querySelector("span");
    dom.locateButton.classList.toggle("is-locating", isPending);
    dom.locateButton.setAttribute("aria-busy", String(isPending));
    dom.locateButton.setAttribute(
      "aria-label",
      isPending ? "正在定位" : state.userLocation ? "重新定位我的位置" : "定位我的位置"
    );
    if (label) {
      label.textContent = isPending ? "定位中" : state.userLocation ? "重新定位" : "定位";
    }
  }

  function handleAmapLocationSuccess(result) {
    var position = result && result.position;
    var lng = position
      ? Number(typeof position.getLng === "function" ? position.getLng() : position.lng)
      : NaN;
    var lat = position
      ? Number(typeof position.getLat === "function" ? position.getLat() : position.lat)
      : NaN;

    if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
      handleAmapLocationError({ info: "NO_POSITION", message: "定位结果没有坐标" });
      return;
    }

    var rawAccuracy = result ? Number(result.accuracy) : NaN;
    var accuracy = Number.isFinite(rawAccuracy) && rawAccuracy > 0 ? rawAccuracy : null;

    // 高德 Geolocation 返回 GCJ-02；直接作为用户坐标，避免再次坐标转换。
    applyUserLocation(lng, lat, accuracy, {
      source: "amap",
      locationType: result && result.location_type ? String(result.location_type) : ""
    });
  }

  function applyUserLocation(lng, lat, accuracy, meta) {
    state.userLocation = {
      lat: lat,
      lng: lng,
      accuracy: accuracy,
      manual: false,
      source: meta && meta.source ? meta.source : "amap"
    };
    state.locationState = "success";
    dom.locateButton.disabled = false;
    dom.locateButton.classList.remove("is-locating");
    dom.locateButton.classList.add("is-located");
    setLocationPending(false);
    updateDistanceOption();

    // 定位成功后默认切换到距离排序；用户仍可用下拉框切回名称排序。
    state.sortMode = "distance";
    dom.sortSelect.value = "distance";

    showUserLocation();
    renderList(getFilteredParks(), { resetScroll: true });
    updateResetState();

    var accuracyText = formatAccuracy(accuracy);
    var locationType = meta && meta.locationType ? meta.locationType : "";
    // 精度超过 150 米，或高德返回的不是浏览器 HTML5 精确定位，都按“大概位置”提示。
    var isCoarse =
      (accuracy !== null && accuracy > 150) ||
      (locationType !== "" && locationType !== "html5");

    if (isCoarse) {
      var coarseText = accuracyText ? "（" + accuracyText + "）" : "";
      setLocationStatus(
        "warning",
        "定位精度较低" + coarseText + "，距离仅供参考；拖动蓝点校正。"
      );
      showToast("定位精度较低" + coarseText + "，可拖动蓝点校正", "info", 6200);
    } else {
      setLocationStatus(
        "success",
        "已定位" +
          (accuracyText ? "（" + accuracyText + "）" : "") +
          " · 距离排序 · 蓝点可拖动校正"
      );
      showToast("定位成功，已按距离由近到远排序", "success", 3200);
    }

    if (map) {
      // 低精度时不放得太大，避免把一个“大概位置”显示得像精确坐标。
      var targetZoom = isCoarse
        ? accuracy && accuracy > 800
          ? 11
          : 12
        : Math.max(map.getZoom(), 13);

      if (typeof map.setZoomAndCenter === "function") {
        map.setZoomAndCenter(targetZoom, [lng, lat]);
      } else {
        map.setZoom(targetZoom);
        map.setCenter([lng, lat]);
      }
    }
  }

  function formatAccuracy(accuracy) {
    if (!Number.isFinite(accuracy) || accuracy <= 0) return "";
    if (accuracy < 1000) return "±" + Math.round(accuracy) + " 米";
    if (accuracy < 10000) return "±" + (accuracy / 1000).toFixed(1) + " 公里";
    return "±" + Math.round(accuracy / 1000) + " 公里";
  }

  function handleAmapLocationError(error) {
    handleLocationError(error, "geo");
  }

  function handleLocationError(error, source) {
    state.locationState = "error";
    dom.locateButton.disabled = false;
    setLocationPending(false);
    updateDistanceOption();

    var rawText = [
      error && error.info,
      error && error.message,
      error && error.code,
      error && error.type
    ]
      .filter(Boolean)
      .join(" ");

    var denied = /DENIED|PERMISSION|AUTH|USER_DENIED|拒绝/i.test(rawText);
    var timeout = /TIMEOUT|TIME_OUT|超时/i.test(rawText);
    var message;

    if (source === "plugin") {
      message = "高德定位插件加载失败，无法获取位置，距离排序不可用；地图与列表仍可正常使用。";
    } else if (denied) {
      message = "无法获取位置，距离排序不可用。你拒绝了定位权限，可继续浏览地图和公园列表。";
    } else if (timeout) {
      message = "定位超时，无法获取位置，距离排序不可用。请稍后重试，或继续浏览地图。";
    } else {
      message = "无法获取位置，距离排序不可用。请检查设备定位服务后再试，其余功能不受影响。";
    }

    if (state.userLocation) {
      message = state.userLocation.manual
        ? "本次定位失败，距离排序仍使用上次手动校正的位置。"
        : "本次定位失败，距离排序仍使用上一次的位置。";
    }

    setLocationStatus("error", message);
    showToast(message, "error", 5200);
  }

  function setLocationStatus(type, message) {
    dom.locationStatus.hidden = false;
    dom.locationStatus.dataset.state = type;
    dom.locationStatus.textContent = message;
  }

  /**
   * 用户位置：蓝色圆点 + 真实精度圈。
   * AMap.Geolocation 返回的坐标已经是 GCJ-02，可直接创建 Marker/Circle。
   * 蓝点可拖动校正；拖动事件在 AMap.Marker 的 dragend 中处理。
   */
  function showUserLocation() {
    if (!map || !window.AMap || !state.userLocation) return;

    if (userMarker) {
      map.remove(userMarker);
      userMarker = null;
    }
    if (userAccuracyCircle) {
      map.remove(userAccuracyCircle);
      userAccuracyCircle = null;
    }

    var location = state.userLocation;

    if (location.accuracy && location.accuracy > 25) {
      userAccuracyCircle = new window.AMap.Circle({
        center: [location.lng, location.lat],
        // 显示高德返回的真实精度半径，不缩小、不夸大。
        radius: location.accuracy,
        strokeColor: "#1f5fa8",
        strokeWeight: 2,
        strokeOpacity: 0.6,
        strokeStyle: "dashed",
        fillColor: "#2e659f",
        fillOpacity: 0.12,
        zIndex: 90,
        bubble: true
      });
      map.add(userAccuracyCircle);
    }

    userMarker = new window.AMap.Marker({
      position: [location.lng, location.lat],
      content:
        '<div class="user-location-wrap" aria-hidden="true">' +
        '<span class="user-location-pulse"></span>' +
        '<span class="user-location-core"></span>' +
        "</div>",
      offset: new window.AMap.Pixel(-22, -22),
      draggable: true,
      title: "我的位置，可拖动校正",
      zIndex: 2000
    });

    userMarker.on("dragstart", function () {
      closeInfoWindow();
    });

    userMarker.on("dragend", handleUserLocationDragEnd);
    map.add(userMarker);
  }

  /**
   * 手动拖动蓝点后，以新坐标作为距离计算基准，并移除失效的自动精度圈。
   */
  function handleUserLocationDragEnd(event) {
    var position = event && event.target ? event.target.getPosition() : null;
    if (!position) return;

    var lng = Number(typeof position.getLng === "function" ? position.getLng() : position.lng);
    var lat = Number(typeof position.getLat === "function" ? position.getLat() : position.lat);
    if (!Number.isFinite(lng) || !Number.isFinite(lat)) return;

    state.userLocation = {
      lat: lat,
      lng: lng,
      accuracy: null,
      manual: true,
      source: "manual"
    };
    state.locationState = "success";

    if (userAccuracyCircle) {
      map.remove(userAccuracyCircle);
      userAccuracyCircle = null;
    }

    if (userMarker && typeof userMarker.setTitle === "function") {
      userMarker.setTitle("已校正的位置，可继续拖动");
    }

    renderList(getFilteredParks(), { resetScroll: true });
    updateDistanceOption();
    updateResetState();

    setLocationStatus("success", "位置已手动校正 · 距离已重新计算");
    showToast("位置已校正，距离已重新计算", "success", 3200);
  }

  /**
   * Haversine 公式：根据经纬度求球面最短距离（直线距离，单位 km）。
   * a = sin²(Δφ/2) + cosφ1·cosφ2·sin²(Δλ/2)
   * c = 2·atan2(√a, √(1−a))
   * d = R·c，其中 R = 6371 km。
   */
  function getDistanceKm(from, park) {
    if (!from || !park) return NaN;

    var lat1 = degToRad(from.lat);
    var lat2 = degToRad(park.lat);
    var deltaLat = degToRad(park.lat - from.lat);
    var deltaLng = degToRad(park.lng - from.lng);

    var a =
      Math.sin(deltaLat / 2) * Math.sin(deltaLat / 2) +
      Math.cos(lat1) * Math.cos(lat2) * Math.sin(deltaLng / 2) * Math.sin(deltaLng / 2);
    var clamped = Math.min(1, Math.max(0, a));
    var c = 2 * Math.atan2(Math.sqrt(clamped), Math.sqrt(1 - clamped));

    return EARTH_RADIUS_KM * c;
  }

  function degToRad(degrees) {
    return (degrees * Math.PI) / 180;
  }

  function getDistanceText(park) {
    if (!state.userLocation) return "";
    var km = getDistanceKm(state.userLocation, park);
    if (!Number.isFinite(km)) return "";

    if (km < 1) {
      var meters = Math.max(10, Math.round((km * 1000) / 10) * 10);
      return meters + " m";
    }

    return km.toFixed(1) + " km";
  }

  function formatDistanceSpoken(km) {
    if (!Number.isFinite(km)) return "";
    if (km < 1) return Math.max(10, Math.round((km * 1000) / 10) * 10) + " 米";
    return km.toFixed(1) + " 公里";
  }

  /* ------------------------------------------------------------------
   * 详情：原生 dialog + URL ?id= 深链接
   * ------------------------------------------------------------------ */
  function openDetail(parkId, options) {
    options = options || {};
    var park = findPark(parkId);
    if (!park) {
      showToast("没有找到这座公园", "error");
      return;
    }

    state.selectedId = park.id;
    updateMarkerHighlight();
    highlightSelectedCard(true);
    lastFocusedElement = document.activeElement;

    // 详情打开后不再需要地图气泡，关闭时把角落的“全览/定位”按钮还回来。
    closeInfoWindow();

    dom.detailContent.innerHTML = buildDetailHtml(park);

    if (typeof dom.detailDialog.showModal === "function") {
      if (!dom.detailDialog.open) dom.detailDialog.showModal();
    } else {
      dom.detailDialog.setAttribute("open", "");
    }

    window.requestAnimationFrame(function () {
      dom.detailClose.focus({ preventScroll: true });
    });

    if (options.updateUrl !== false) {
      updateUrlWithPark(park.id);
    }
  }

  function buildDetailHtml(park) {
    var primaryType = park.tags[0] || "城市绿地";
    var district = park.district || "上海";
    var englishName = park.englishName
      ? '<p class="detail-en">' + escapeHtml(park.englishName) + "</p>"
      : "";
    var tagsHtml = park.tags.length
      ? park.tags
          .map(function (tag) {
            return '<span class="detail-tag">' + escapeHtml(tag) + "</span>";
          })
          .join("")
      : '<span class="detail-tag">暂无标签</span>';

    return (
      '<header class="detail-hero">' +
      '<p class="detail-kicker">' +
      escapeHtml(district + " · " + primaryType) +
      "</p>" +
      '<h2 class="detail-title" id="detail-title">' +
      escapeHtml(park.name) +
      "</h2>" +
      englishName +
      '<p class="detail-highlight">' +
      escapeHtml(park.highlight || "暂无推荐语，欢迎到现场慢慢发现。") +
      "</p>" +
      '<div class="detail-tags" aria-label="公园标签">' +
      tagsHtml +
      "</div>" +
      "</header>" +
      '<div class="detail-body">' +
      '<section class="detail-section">' +
      "<h3>关于这里</h3>" +
      "<p>" +
      escapeHtml(park.history || "暂无信息") +
      "</p>" +
      "</section>" +
      '<dl class="detail-facts">' +
      '<div class="detail-fact"><dt>面积</dt><dd>' +
      escapeHtml(park.area || "暂无信息") +
      "</dd></div>" +
      '<div class="detail-fact"><dt>开放时间</dt><dd>' +
      escapeHtml(park.hours || "暂无信息") +
      "</dd></div>" +
      '<div class="detail-fact"><dt>所在区域</dt><dd>' +
      escapeHtml(district) +
      "</dd></div>" +
      '<div class="detail-fact"><dt>地址</dt><dd>' +
      escapeHtml(park.address || "暂无信息") +
      "</dd></div>" +
      "</dl>" +
      "</div>" +
      '<footer class="detail-foot">' +
      '<button class="detail-map-button" type="button" data-detail-fly="' +
      escapeAttr(park.id) +
      '">在地图上查看' +
      '<svg width="15" height="15" viewBox="0 0 15 15" aria-hidden="true">' +
      '<path d="M3 7.5h9M8 3l4.5 4.5L8 12" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/>' +
      "</svg>" +
      "</button>" +
      '<p class="detail-note">静态资料整理<br>开放时间以园区公告为准</p>' +
      "</footer>"
    );
  }

  function closeDetail() {
    if (typeof dom.detailDialog.close === "function" && dom.detailDialog.open) {
      dom.detailDialog.close();
    } else {
      dom.detailDialog.removeAttribute("open");
      handleDetailClosed();
    }
  }

  function handleDetailClosed() {
    removeParkIdFromUrl();

    var canRestoreFocus =
      lastFocusedElement &&
      lastFocusedElement !== document.body &&
      lastFocusedElement.isConnected &&
      !dom.detailDialog.contains(lastFocusedElement);

    if (canRestoreFocus) {
      lastFocusedElement.focus({ preventScroll: true });
      return;
    }

    var selectedCard = dom.parkList.querySelector(".park-card.is-selected");
    if (selectedCard) {
      selectedCard.focus({ preventScroll: true });
    }
  }

  function updateUrlWithPark(parkId) {
    if (!window.history || !window.history.replaceState) return;
    try {
      var url = new URL(window.location.href);
      url.searchParams.set("id", parkId);
      window.history.replaceState({ parkId: parkId }, "", url);
    } catch (error) {
      // 极少数受限浏览器会拒绝 history 操作，不影响详情展示。
    }
  }

  function removeParkIdFromUrl() {
    if (!window.history || !window.history.replaceState) return;
    try {
      var url = new URL(window.location.href);
      if (!url.searchParams.has("id")) return;
      url.searchParams.delete("id");
      window.history.replaceState(null, "", url);
    } catch (error) {
      // 忽略 URL 清理失败。
    }
  }

  function restoreDetailFromUrl() {
    var parkId = new URLSearchParams(window.location.search).get("id");
    if (!parkId) return;

    var park = findPark(parkId);
    if (!park) {
      showToast("链接中的公园不存在，已为你打开完整名录", "error", 4200);
      removeParkIdFromUrl();
      return;
    }

    state.selectedId = park.id;
    highlightSelectedCard(true);

    if (map) {
      map.setZoom(Math.max(map.getZoom(), 14));
      map.setCenter([park.lng, park.lat]);
    }

    openDetail(park.id, { updateUrl: false });
  }

  /* ------------------------------------------------------------------
   * 通用事件与工具函数
   * ------------------------------------------------------------------ */
  function handleDocumentClick(event) {
    if (!event.target || !event.target.closest) return;

    var infoClose = event.target.closest("[data-close-info]");
    if (infoClose) {
      event.preventDefault();
      closeInfoWindow();
      return;
    }

    var popupDetail = event.target.closest("[data-open-park]");
    if (popupDetail) {
      event.preventDefault();
      openDetail(popupDetail.getAttribute("data-open-park"));
      return;
    }

    var detailFly = event.target.closest("[data-detail-fly]");
    if (detailFly) {
      var flyId = detailFly.getAttribute("data-detail-fly");
      closeDetail();
      window.setTimeout(function () {
        focusPark(flyId);
      }, 160);
      return;
    }

    var retry = event.target.closest("[data-retry-parks]");
    if (retry) {
      loadParks();
      return;
    }

    var emptyReset = event.target.closest("[data-empty-reset]");
    if (emptyReset) {
      resetFilters();
    }
  }

  function showToast(message, type, duration) {
    if (!dom.toast || !dom.toastMessage) return;

    window.clearTimeout(toastTimer);
    window.clearTimeout(toastRemoveTimer);

    dom.toast.hidden = false;
    dom.toast.dataset.type = type || "info";
    dom.toastMessage.textContent = message;

    window.requestAnimationFrame(function () {
      dom.toast.classList.add("is-visible");
    });

    toastTimer = window.setTimeout(function () {
      dom.toast.classList.remove("is-visible");
      toastRemoveTimer = window.setTimeout(function () {
        dom.toast.hidden = true;
      }, 220);
    }, duration || 4200);
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
