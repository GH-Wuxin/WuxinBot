
/* 未接线的按钮：显式禁用，不再假装能点 */
function markUnwiredButtons() {
  Array.prototype.forEach.call(document.querySelectorAll('#view button'), function (button) {
    if (Object.keys(button.dataset || {}).length) return;
    if (button.getAttribute('onclick')) return;
    if (button.classList.contains('is-guarded')) return;
    button.classList.add('is-guarded');
    button.setAttribute('aria-disabled', 'true');
    button.title = '这个操作还没有接入后台';
    button.addEventListener('click', function (event) { event.preventDefault(); event.stopPropagation(); }, true);
  });
}

var __renderUnwired = render;
render = function (page) {
  __renderUnwired(page);
  markUnwiredButtons();
};
window.goto = render;
render(window.__page || 'overview');

/* 把首页两个死按钮接上 */
function wireHeadButtons() {
  Array.prototype.forEach.call(document.querySelectorAll('#view .page-head button'), function (button) {
    const text = button.textContent.trim();
    if (text === '刷新状态') {
      button.dataset.refreshState = '1';
      button.classList.remove('is-guarded');
      button.title = '重新读取后台状态';
    }
    if (text === '更多操作') {
      button.dataset.openMore = '1';
      button.classList.remove('is-guarded');
      button.title = '打开更多操作';
    }
  });
}
document.addEventListener('click', function (event) {
  const refresh = event.target.closest('[data-refresh-state]');
  if (refresh) {
    event.preventDefault();
    Promise.resolve(typeof hydrate === 'function' ? hydrate() : null)
      .then(() => (typeof bootAll === 'function' ? bootAll() : null))
      .then(() => notify('状态已刷新', 'pink'))
      .catch((error) => notify('刷新失败：' + error.message, 'danger'));
    return;
  }
  const more = event.target.closest('[data-open-more]');
  if (more) {
    event.preventDefault();
    const menu = document.getElementById('moreMenu');
    if (menu) menu.hidden = !menu.hidden;
  }
}, true);
var __renderHeads = render;
render = function (page) { __renderHeads(page); wireHeadButtons(); };
window.goto = render;
render(window.__page || 'overview');
