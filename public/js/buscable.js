// Desplegables con busqueda: convierte cada <select data-buscable> en un
// campo donde se escribe para filtrar. Encuentra por cualquier parte del
// texto ("620" -> "EAP620 HD") y por las iniciales de sus palabras
// ("pl" -> "Pueblo Libre", "sc" -> "SW Clinica").
// El <select> original sigue en el formulario (oculto) y es el que se envia,
// asi que sin JavaScript el formulario funciona igual.
//
// Teclado: flechas para moverse, Enter para elegir, Escape para cerrar.
// Las opciones con el atributo hidden o disabled no se ofrecen (un formulario
// puede ocultar opciones segun otro campo y avisar con el evento "buscable:refrescar").
(function () {
  'use strict';
  var norm = function (s) { return String(s || '').toLowerCase().normalize('NFD').replace(/[^\x00-\x7f]/g, ''); };
  var initials = function (s) { return norm(s).split(/[^a-z0-9]+/).filter(Boolean).map(function (w) { return w[0]; }).join(''); };
  var uid = 0;

  function enhance(select) {
    if (select.dataset.buscableListo) return;
    select.dataset.buscableListo = '1';
    uid += 1;
    var wrap = document.createElement('div');
    wrap.className = 'buscable position-relative';
    var input = document.createElement('input');
    input.type = 'text';
    input.className = select.className.replace('form-select', 'form-control');
    input.autocomplete = 'off';
    input.spellcheck = false;
    input.setAttribute('role', 'combobox');
    input.setAttribute('aria-autocomplete', 'list');
    input.setAttribute('aria-expanded', 'false');
    input.placeholder = select.getAttribute('data-buscable') || 'Escriba para buscar…';
    var list = document.createElement('ul');
    list.className = 'list-group position-absolute w-100 shadow-sm';
    list.id = 'buscable_' + uid;
    list.setAttribute('role', 'listbox');
    list.style.cssText = 'z-index: 1050; max-height: 16rem; overflow: auto; display: none;';
    input.setAttribute('aria-controls', list.id);
    select.parentNode.insertBefore(wrap, select);
    wrap.appendChild(input);
    wrap.appendChild(list);
    wrap.appendChild(select);
    // La etiqueta del select pasa a enfocar el campo de busqueda.
    if (select.id) {
      input.id = select.id + '_buscar';
      var label = document.querySelector('label[for="' + select.id + '"]');
      if (label) label.setAttribute('for', input.id);
    }
    select.tabIndex = -1;
    select.setAttribute('aria-hidden', 'true');
    select.style.cssText = 'position: absolute; opacity: 0; pointer-events: none; height: 0; width: 0; padding: 0; border: 0;';

    var active = -1;
    var shown = [];
    var options = function () { return Array.prototype.filter.call(select.options, function (o) { return !o.hidden && !o.disabled; }); };
    var show = function () { input.value = select.selectedIndex >= 0 && select.value !== '' ? select.options[select.selectedIndex].text : ''; };
    var close = function () { list.style.display = 'none'; input.setAttribute('aria-expanded', 'false'); active = -1; };
    var mark = function () {
      Array.prototype.forEach.call(list.children, function (li, i) { li.classList.toggle('active', i === active); if (i === active && li.scrollIntoView) li.scrollIntoView({ block: 'nearest' }); });
    };
    var render = function (query) {
      var q = norm(query).trim();
      var qi = q.replace(/[^a-z0-9]/g, '');
      shown = options().filter(function (o) {
        if (!q) return true;
        if (o.value === '') return false;
        return norm(o.text).indexOf(q) > -1 || (qi && initials(o.text).indexOf(qi) === 0);
      });
      list.innerHTML = '';
      shown.forEach(function (o, i) {
        var li = document.createElement('li');
        li.className = 'list-group-item list-group-item-action py-1 px-2 small' + (o.value === '' ? ' text-muted' : '');
        li.setAttribute('role', 'option');
        li.textContent = o.text;
        li.addEventListener('mousedown', function (e) { e.preventDefault(); choose(i); });
        list.appendChild(li);
      });
      if (!shown.length) {
        var none = document.createElement('li');
        none.className = 'list-group-item py-1 px-2 small text-muted';
        none.textContent = 'Sin coincidencias';
        list.appendChild(none);
      }
      active = q && shown.length ? 0 : -1;
      mark();
      list.style.display = 'block';
      input.setAttribute('aria-expanded', 'true');
    };
    var choose = function (i) {
      if (!shown[i]) return;
      select.value = shown[i].value;
      show();
      close();
      select.dispatchEvent(new Event('change', { bubbles: true }));
    };

    input.addEventListener('focus', function () { input.select(); render(''); });
    input.addEventListener('input', function () { render(input.value); });
    input.addEventListener('blur', function () { close(); show(); });
    input.addEventListener('keydown', function (e) {
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        if (list.style.display === 'none') { render(input.value); return; }
        if (!shown.length) return;
        active = (active + (e.key === 'ArrowDown' ? 1 : -1) + shown.length) % shown.length;
        mark();
      } else if (e.key === 'Enter') {
        if (list.style.display !== 'none') { e.preventDefault(); if (active > -1) choose(active); else if (shown.length === 1) choose(0); }
      } else if (e.key === 'Escape') {
        close(); show();
      }
    });
    select.addEventListener('change', show);
    select.addEventListener('buscable:refrescar', show);
    show();
  }

  function init(root) { (root || document).querySelectorAll('select[data-buscable]').forEach(enhance); }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', function () { init(); });
  else init();
  window.Buscable = { init: init };
})();
