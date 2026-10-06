// Comportamientos comunes de toda la aplicacion (se carga en partials/foot):
//
// 1) Avisos que se pueden descartar: un elemento con data-aviso="clave"
//    recibe el boton "No volver a mostrar". Se recuerda en este navegador
//    junto con el TEXTO del aviso: si el aviso cambia (otro problema),
//    vuelve a aparecer.
//
// 2) Buscador con sugerencias: todo campo name="q" de un formulario recibe
//    sugerencias mientras se escribe. Salen de los datos de la tabla de la
//    pantalla o, si el campo tiene data-sugerencias="/url", del servidor
//    (?q=texto -> ["valor", ...]), para tablas paginadas en el servidor.
//    data-sugerencias="no" las apaga.
(function () {
  'use strict';

  var MAX = 12;
  function fold(s) { return String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase(); }
  function hash(s) {
    var h = 5381;
    for (var i = 0; i < s.length; i += 1) h = ((h << 5) + h + s.charCodeAt(i)) | 0;
    return (h >>> 0).toString(36);
  }
  function store(k, v) { try { if (v === undefined) return localStorage.getItem(k); localStorage.setItem(k, v); } catch (e) { return null; } return null; }

  // ---- 1) avisos
  function setupNotices() {
    Array.prototype.forEach.call(document.querySelectorAll('[data-aviso]'), function (el) {
      var k = 'aviso:' + el.getAttribute('data-aviso') + ':' + hash(el.textContent.replace(/\s+/g, ' ').trim());
      if (store(k)) { el.remove(); return; }
      var b = document.createElement('button');
      b.type = 'button';
      b.className = 'btn btn-sm btn-link aviso-descartar';
      b.textContent = 'No volver a mostrar';
      b.title = 'Ocultar este aviso en este navegador (vuelve si el aviso cambia)';
      b.addEventListener('click', function () { store(k, new Date().toISOString()); el.remove(); });
      el.appendChild(b);
    });
  }

  // ---- 2) sugerencias del buscador
  // Textos de las celdas de las tablas de la pantalla (una linea por dato).
  function tableValues() {
    var seen = {};
    var out = [];
    Array.prototype.forEach.call(document.querySelectorAll('.table-responsive > table tbody td'), function (td) {
      if (td.querySelector('input, select, textarea, button, form')) return;
      // Cada parte de la celda por separado (nombre, correo debajo, etc.).
      var parts = [];
      Array.prototype.forEach.call(td.childNodes, function (node) { parts.push(node.textContent || ''); });
      parts.forEach(function (line) {
        var v = line.replace(/\s+/g, ' ').trim();
        if (v.length < 2 || v.length > 70 || v === '—' || seen[v]) return;
        seen[v] = true;
        out.push(v);
      });
    });
    return out;
  }
  function matches(values, term) {
    var t = fold(term);
    var starts = [];
    var inside = [];
    values.forEach(function (v) {
      var f = fold(v);
      if (f === t) return;
      if (f.indexOf(t) === 0) starts.push(v); else if (f.indexOf(t) > -1) inside.push(v);
    });
    return starts.concat(inside).slice(0, MAX);
  }

  function setupSearch() {
    Array.prototype.forEach.call(document.querySelectorAll('form input[name="q"]'), function (input, n) {
      input.classList.add('campo-buscar');
      var url = input.getAttribute('data-sugerencias');
      if (url === 'no' || input.getAttribute('list')) return;
      var list = document.createElement('datalist');
      list.id = 'sugerencias_busqueda_' + n;
      document.body.appendChild(list);
      input.setAttribute('list', list.id);
      input.setAttribute('autocomplete', 'off');
      var fill = function (values) {
        list.textContent = '';
        values.slice(0, MAX).forEach(function (v) {
          var o = document.createElement('option');
          o.value = v;
          list.appendChild(o);
        });
      };
      var cache = null;
      var timer = null;
      var last = '';
      input.addEventListener('input', function () {
        var term = input.value.trim();
        if (term.length < 2) { fill([]); return; }
        if (!url) {
          if (!cache) cache = tableValues();
          fill(matches(cache, term));
          return;
        }
        clearTimeout(timer);
        timer = setTimeout(function () {
          if (term === last) return;
          last = term;
          fetch(url + (url.indexOf('?') > -1 ? '&' : '?') + 'q=' + encodeURIComponent(term), { credentials: 'same-origin', headers: { Accept: 'application/json' } })
            .then(function (r) { return r.ok ? r.json() : []; })
            .then(function (values) { if (input.value.trim() === term && Array.isArray(values)) fill(values.map(String)); })
            .catch(function () { /* sin sugerencias */ });
        }, 200);
      });
    });
  }

  function init() { setupNotices(); setupSearch(); }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
