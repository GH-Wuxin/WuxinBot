
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
