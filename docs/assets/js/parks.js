/**
 * 上海公园地图页
 * ------------------------------------------------------------------
 * 手机适配关键处理：
 * 1. 初始化时检测 768px 断点，手机上默认 zoom 12（桌面为 11），让市中心标记更清楚。
 * 2. 列表随地图联动：点击列表项 → flyTo + 打开 marker 弹窗；点击 marker → 列表同步高亮并滚动到可见位置。
 * 3. 底部定位按钮始终位于地图右下角、拇指易触达区域；定位失败只影响距离排序，不阻断地图与列表。
 *    定位精度会在状态栏显示；低精度时绘制真实精度圈，蓝点可拖动校正。
 * 4. 详情使用原生 <dialog>：桌面居中，手机为底部抽屉，层级高于列表和 Leaflet 控件，弹窗不会被遮挡。
 * 5. 没有在滚动列表里放置 fixed 元素，列表使用原生滚动 + overscroll-behavior，触控滚动更顺滑。
 *
 * 数据流：fetch parks.json → normalize → filter（搜索 + 标签）→ sort（名称 / Haversine 距离）→
 *        同步渲染列表与 Leaflet marker。新增公园只需在 JSON 中增加记录。
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
  var markerLayer = null;
  var userLayer = null;
  var userMarker = null;
  var userAccuracyCircle = null;
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
        if (map) map.invalidateSize();
      }, 150);
    });
  }

  /* ------------------------------------------------------------------
   * 地图初始化
   * - Leaflet 通过 CDN 引入；若 CDN 被拦截，页面仍保留列表与详情功能。
   * - 手机默认缩放级别更大，方便看清密集的市中心 marker。
   * ------------------------------------------------------------------ */
  function initMap() {
    if (!window.L) {
      showMapUnavailable();
      showToast("地图资源加载失败，仍可浏览公园列表", "error", 5200);
      return;
    }

    var isMobile = window.matchMedia(MOBILE_QUERY).matches;

    map = window.L.map("map", {
      center: [31.23, 121.47],
      zoom: isMobile ? 12 : 11,
      zoomControl: false,
      worldCopyJump: true,
      preferCanvas: false
    });

    window.L.control.zoom({ position: "topright" }).addTo(map);
    window.L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
      maxZoom: 19,
      attribution:
        '&copy; <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">OpenStreetMap</a> contributors'
    }).addTo(map);

    markerLayer = window.L.layerGroup().addTo(map);
    userLayer = window.L.layerGroup().addTo(map);

    // 移动端地址栏出现/隐藏后，容器尺寸可能变化，主动通知 Leaflet 重算。
    window.setTimeout(function () {
      if (map) map.invalidateSize();
    }, 0);

    map.on("popupopen", function () {
      // 手机上弹窗打开时隐藏角落浮层，避免遮住弹窗标题和按钮。
      if (dom.mapPanel) dom.mapPanel.classList.add("has-popup");
      // Leaflet 自身会处理 autoPan；这里只确保弹窗在窄屏上不被地图边缘裁切。
      if (window.matchMedia(MOBILE_QUERY).matches) {
        window.setTimeout(function () {
          if (map) map.invalidateSize({ pan: false });
        }, 50);
      }
    });

    map.on("popupclose", function () {
      if (dom.mapPanel) dom.mapPanel.classList.remove("has-popup");
    });
  }

  function hideMapLoading() {
    if (!dom.mapLoading) return;
    dom.mapLoading.classList.add("is-hidden");
  }

  function showMapUnavailable() {
    hideMapLoading();
    if (!dom.mapCanvas) return;
    dom.mapCanvas.innerHTML =
      '<div class="map-fallback">' +
      '<p>地图暂时无法显示</p>' +
      '<span>请检查网络后刷新页面，公园列表与详情仍可正常使用。</span>' +
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
      if (map) map.closePopup();
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
   * Leaflet marker 与弹窗
   * ------------------------------------------------------------------ */
  function renderMarkers(parks) {
    if (!map || !markerLayer || !window.L) return;

    window.clearTimeout(state.popupTimer);
    map.closePopup();
    markerLayer.clearLayers();
    state.markers.clear();

    var isCompactMap = window.matchMedia(MOBILE_QUERY).matches;

    parks.forEach(function (park) {
      var marker = window.L.marker([park.lat, park.lng], {
        icon: createMarkerIcon(park.id === state.selectedId),
        title: park.name,
        alt: park.name,
        riseOnHover: true,
        keyboard: true,
        zIndexOffset: park.id === state.selectedId ? 1000 : 0
      });

      marker.bindPopup(buildPopupHtml(park), {
        maxWidth: 300,
        minWidth: 248,
        autoPan: true,
        autoPanPadding: isCompactMap ? [16, 20] : [24, 32],
        closeButton: true,
        keepInView: true,
        className: "park-popup-shell"
      });

      marker.on("click", function () {
        state.selectedId = park.id;
        updateMarkerHighlight();
        highlightSelectedCard(true);
      });

      marker.addTo(markerLayer);

      var markerElement = marker.getElement();
      if (markerElement) {
        markerElement.setAttribute("role", "button");
        markerElement.setAttribute("aria-label", park.name + "，打开地图简介");
      }

      state.markers.set(park.id, marker);
    });

    updateMarkerHighlight();
  }

  function createMarkerIcon(active) {
    var className = "park-marker" + (active ? " is-active" : "");
    return window.L.divIcon({
      className: "park-marker-icon",
      html:
        '<div class="' +
        className +
        '">' +
        '<svg viewBox="0 0 32 42" aria-hidden="true" focusable="false">' +
        '<path d="M16 1C7.7 1 1 7.7 1 16c0 11 15 24.5 15 24.5S31 27 31 16C31 7.7 24.3 1 16 1Z" fill="currentColor" stroke="#f7f2e7" stroke-width="2"/>' +
        '<circle cx="16" cy="16" r="4.6" fill="#f7f2e7"/>' +
        "</svg>" +
        "</div>",
      iconSize: [44, 44],
      iconAnchor: [22, 41],
      popupAnchor: [0, -38]
    });
  }

  function updateMarkerHighlight() {
    state.markers.forEach(function (marker, id) {
      var markerElement = marker.getElement();
      var pin = markerElement ? markerElement.querySelector(".park-marker") : null;
      if (pin) {
        pin.classList.toggle("is-active", id === state.selectedId);
      }
      marker.setZIndexOffset(id === state.selectedId ? 1000 : 0);
    });
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

    map.closePopup();
    var targetZoom = Math.max(map.getZoom(), 14);
    var target = [park.lat, park.lng];

    if (options.fly !== false) {
      if (prefersReducedMotion.matches) {
        map.setView(target, targetZoom, { animate: false });
      } else {
        map.flyTo(target, targetZoom, { duration: 0.7, easeLinearity: 0.25 });
      }
    }

    if (options.openDetail) {
      openDetail(park.id);
      return;
    }

    if (options.openPopup === false) return;

    window.clearTimeout(state.popupTimer);
    var delay = options.fly === false ? 20 : prefersReducedMotion.matches ? 80 : 680;
    state.popupTimer = window.setTimeout(function () {
      var marker = state.markers.get(park.id);
      if (marker) marker.openPopup();
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
    fitParksInView(visible);
  }

  function fitParksInView(parks) {
    if (!map || !window.L || !parks.length) return;

    map.closePopup();
    var bounds = window.L.latLngBounds(
      parks.map(function (park) {
        return [park.lat, park.lng];
      })
    );

    map.fitBounds(bounds, {
      padding: [46, 46],
      maxZoom: parks.length === 1 ? 15 : 13,
      animate: !prefersReducedMotion.matches
    });
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
    if (!("geolocation" in navigator)) {
      state.locationState = "error";
      setLocationPending(false);
      setLocationStatus(
        "error",
        "当前浏览器不支持定位。无法获取位置，距离排序不可用；地图与列表仍可正常使用。"
      );
      showToast("无法获取位置，距离排序不可用", "error", 4800);
      dom.locateButton.disabled = true;
      return;
    }

    if (state.locationState === "pending") return;

    state.locationState = "pending";
    setLocationPending(true);
    setLocationStatus("pending", "正在获取你的位置…");
    dom.locateButton.disabled = true;

    try {
      // maximumAge 设为 0：强制尽量拿到新鲜坐标，避免复用过期的缓存位置。
      // 用户如果仍觉得不准，可以拖动地图上的蓝点进行手动校正。
      navigator.geolocation.getCurrentPosition(handleLocationSuccess, handleLocationError, {
        enableHighAccuracy: true,
        timeout: 15000,
        maximumAge: 0
      });
    } catch (error) {
      handleLocationError(error);
    }
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

  function handleLocationSuccess(position) {
    var coords = position && position.coords;
    var lat = coords ? Number(coords.latitude) : NaN;
    var lng = coords ? Number(coords.longitude) : NaN;

    if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
      handleLocationError({ code: 2 });
      return;
    }

    var rawAccuracy = coords ? Number(coords.accuracy) : NaN;
    var accuracy = Number.isFinite(rawAccuracy) && rawAccuracy > 0 ? rawAccuracy : null;

    state.userLocation = {
      lat: lat,
      lng: lng,
      accuracy: accuracy,
      manual: false
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

    // 重新生成弹窗内容，让已存在的 marker 弹窗也能读到最新定位距离。
    renderMarkers(getFilteredParks());
    showUserLocation();
    renderList(getFilteredParks(), { resetScroll: true });
    updateResetState();

    var accuracyText = formatAccuracy(accuracy);
    // 浏览器 / 系统定位常见精度为 10–100 米；超过 150 米时明确提示为“大概位置”。
    var isCoarse = accuracy !== null && accuracy > 150;

    if (isCoarse) {
      setLocationStatus(
        "warning",
        "精度约 " + accuracyText + "，距离仅供参考；拖动蓝点校正。"
      );
      showToast("定位精度较低（" + accuracyText + "），可拖动蓝点校正", "info", 6200);
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
        ? accuracy > 800
          ? 11
          : 12
        : Math.max(map.getZoom(), 13);

      if (prefersReducedMotion.matches) {
        map.setView([lat, lng], targetZoom, { animate: false });
      } else {
        map.flyTo([lat, lng], targetZoom, { duration: 0.8, easeLinearity: 0.25 });
      }
    }
  }

  function formatAccuracy(accuracy) {
    if (!Number.isFinite(accuracy) || accuracy <= 0) return "";
    if (accuracy < 1000) return "±" + Math.round(accuracy) + " 米";
    if (accuracy < 10000) return "±" + (accuracy / 1000).toFixed(1) + " 公里";
    return "±" + Math.round(accuracy / 1000) + " 公里";
  }

  function handleLocationError(error) {
    state.locationState = "error";
    dom.locateButton.disabled = false;
    setLocationPending(false);
    updateDistanceOption();

    var code = error && typeof error.code === "number" ? error.code : -1;
    var message;

    if (code === 1) {
      message = "无法获取位置，距离排序不可用。你拒绝了定位权限，可继续浏览地图和公园列表。";
    } else if (code === 3) {
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
   * 蓝点可拖动：浏览器定位依赖系统 / 网络，室内或 VPN 环境可能偏差很大，
   * 手动校正比假装精确更可靠。拖动后会立刻重算列表与弹窗中的直线距离。
   */
  function showUserLocation() {
    if (!map || !window.L || !userLayer || !state.userLocation) return;

    userLayer.clearLayers();
    userMarker = null;
    userAccuracyCircle = null;

    var location = state.userLocation;

    if (location.accuracy && location.accuracy > 25) {
      userAccuracyCircle = window.L.circle([location.lat, location.lng], {
        // 显示浏览器真实返回的精度半径，不缩小、不夸大。
        radius: location.accuracy,
        color: "#1f5fa8",
        weight: 2,
        opacity: 0.6,
        dashArray: "5 5",
        fillColor: "#2e659f",
        fillOpacity: 0.12,
        interactive: false,
        className: "user-accuracy-circle"
      }).addTo(userLayer);
    }

    var userIcon = window.L.divIcon({
      className: "user-location-icon",
      html:
        '<span class="user-location-wrap" aria-hidden="true">' +
        '<span class="user-location-pulse"></span>' +
        '<span class="user-location-core"></span>' +
        "</span>",
      iconSize: [44, 44],
      iconAnchor: [22, 22]
    });

    userMarker = window.L.marker([location.lat, location.lng], {
      icon: userIcon,
      draggable: true,
      autoPan: true,
      interactive: true,
      keyboard: false,
      zIndexOffset: 2000,
      title: "我的位置，可拖动校正",
      alt: "我的位置，可拖动校正"
    });

    userMarker.bindTooltip("我的位置 · 可拖动校正", {
      direction: "top",
      offset: [0, -15],
      opacity: 0.92
    });

    userMarker.on("dragstart", function () {
      if (map) map.stop();
      userMarker.closeTooltip();
    });

    userMarker.on("dragend", handleUserLocationDragEnd);
    userMarker.addTo(userLayer);

    var markerElement = userMarker.getElement();
    if (markerElement) {
      markerElement.setAttribute("aria-label", "我的位置，可拖动校正");
    }
  }

  /**
   * 手动拖动蓝点后，以新坐标作为距离计算基准，并移除失效的自动精度圈。
   */
  function handleUserLocationDragEnd(event) {
    var latlng = event && event.target ? event.target.getLatLng() : null;
    if (!latlng) return;

    state.userLocation = {
      lat: latlng.lat,
      lng: latlng.lng,
      accuracy: null,
      manual: true
    };
    state.locationState = "success";

    if (userAccuracyCircle && userLayer) {
      userLayer.removeLayer(userAccuracyCircle);
      userAccuracyCircle = null;
    }

    if (userMarker) {
      userMarker.setTooltipContent("已校正的位置 · 可继续拖动");
    }

    renderMarkers(getFilteredParks());
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
    if (map) map.closePopup();

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
      map.setView([park.lat, park.lng], Math.max(map.getZoom(), 14), { animate: false });
    }

    openDetail(park.id, { updateUrl: false });
  }

  /* ------------------------------------------------------------------
   * 通用事件与工具函数
   * ------------------------------------------------------------------ */
  function handleDocumentClick(event) {
    if (!event.target || !event.target.closest) return;

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
