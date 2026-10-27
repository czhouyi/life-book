/**
 * 书架首页的小增强：从 parks.json 读取实际条目数。
 * 新增公园时只需改 JSON，首页的“处绿地”会同步更新；请求失败则保留 HTML 中的兜底数字。
 */
(function () {
  "use strict";

  var countNodes = document.querySelectorAll("[data-park-count]");
  if (!countNodes.length) return;

  fetch("parks/data/parks.json", { cache: "no-cache" })
    .then(function (response) {
      if (!response.ok) throw new Error("HTTP " + response.status);
      return response.json();
    })
    .then(function (parks) {
      if (!Array.isArray(parks)) return;
      var count = String(parks.length);
      countNodes.forEach(function (node) {
        node.textContent = count;
      });
    })
    .catch(function () {
      // 静态页面的装饰性数字，失败时无需打扰用户，保留兜底值即可。
    });
})();
