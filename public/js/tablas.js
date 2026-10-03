// Tablas de listado de toda la aplicacion: cuantos registros mostrar,
// filtros por columna (como en Excel: se marcan los valores a mostrar),
// columnas que se pueden estirar y cambiar de lugar. Se aplica solo, a toda
// tabla con encabezado que este dentro de un .table-responsive; lo que cada
// persona ajusta se recuerda en su navegador, por pantalla y por tabla.
//
// Para dejar una tabla como esta: <table data-tabla="no">.
// Una tabla que ya pagina en el servidor (trae su propio .pagination en la
// misma tarjeta) conserva su paginacion; solo gana las columnas ajustables.
(function () {
  'use strict';

  var SIZES = [10, 20, 30, 40, 50, 100, 0]; // 0 = todos
  var DEFAULT_SIZE = 50;
  var MIN_WIDTH = 48;
  var PAGER_FROM = 10; // con 10 filas o menos no hace falta paginar

  function load(key) {
    try { return JSON.parse(localStorage.getItem(key) || '{}') || {}; } catch (e) { return {}; }
  }
  function save(key, value) {
    try { localStorage.setItem(key, JSON.stringify(value)); } catch (e) { /* navegador sin almacenamiento: no se recuerda */ }
  }

  function setup(table, index) {
    var head = table.tHead;
    if (!head || !head.rows.length || table.getAttribute('data-tabla') === 'no') return;
    var headRow = head.rows[head.rows.length - 1];
    var total = headRow.cells.length;
    if (total < 2) return;
    var key = 'tabla:' + location.pathname + ':' + index;
    var prefs = load(key);
    var wrap = table.parentNode;

    // Nombre estable de cada columna (para recordar orden y ancho aunque
    // cambie su posicion): data-col, o el texto del encabezado.
    var seen = {};
    Array.prototype.forEach.call(headRow.cells, function (th, i) {
      var name = th.getAttribute('data-col') || th.textContent.replace(/\s+/g, ' ').trim() || 'col' + i;
      seen[name] = (seen[name] || 0) + 1;
      th.setAttribute('data-columna', seen[name] > 1 ? name + '#' + seen[name] : name);
    });
    var names = function () {
      return Array.prototype.map.call(headRow.cells, function (th) { return th.getAttribute('data-columna'); });
    };

    // Las filas con celdas combinadas (totales, "no hay registros") no se
    // pueden reordenar por columna: si las hay fuera del cuerpo, las
    // columnas no se mueven en esa tabla (si se estiran).
    var movable = Array.prototype.every.call(table.rows, function (row) {
      return row.cells.length === total || (row.parentNode.tagName === 'TBODY' && row.cells.length === 1);
    });

    function moveColumn(from, to) {
      if (from === to) return;
      Array.prototype.forEach.call(table.rows, function (row) {
        if (row.cells.length !== total) return;
        var cell = row.cells[from];
        row.insertBefore(cell, to < from ? row.cells[to] : row.cells[to].nextSibling);
      });
    }

    if (movable && Array.isArray(prefs.orden)) {
      prefs.orden.forEach(function (name, target) {
        var current = names().indexOf(name);
        if (current > -1 && target < total) moveColumn(current, target);
      });
    }

    var body = table.tBodies[0];

    // --- Ancho de columnas -------------------------------------------
    // Al primer ajuste la tabla pasa a anchos fijos (los que tenia en ese
    // momento), para que estirar una columna no encoja las demas: la tabla
    // crece y su contenedor se desplaza.
    function freeze() {
      if (table.classList.contains('tabla-fija')) return;
      // Se mide con TODAS las filas a la vista: el ancho natural de una
      // columna depende de las filas visibles, y el de otra pagina puede
      // ser unos pixeles mayor (quedaria cortado con puntos suspensivos).
      var hidden = body ? Array.prototype.filter.call(body.rows, function (r) { return r.hidden; }) : [];
      hidden.forEach(function (r) { r.hidden = false; });
      // offsetWidth redondea hacia abajo: con el ancho exacto, medio pixel
      // de menos ya recorta el texto. Se redondea hacia arriba, con holgura.
      var widths = Array.prototype.map.call(headRow.cells, function (th) {
        return th.offsetWidth ? Math.ceil(th.getBoundingClientRect().width) + 1 : 0;
      });
      hidden.forEach(function (r) { r.hidden = true; });
      Array.prototype.forEach.call(headRow.cells, function (th, i) { if (widths[i]) th.style.width = widths[i] + 'px'; });
      table.style.width = widths.reduce(function (a, b) { return a + b; }, 0) + 'px';
      table.classList.add('tabla-fija');
    }

    function applyWidths() {
      if (!prefs.anchos || !Object.keys(prefs.anchos).length) return;
      freeze();
      var sum = 0;
      Array.prototype.forEach.call(headRow.cells, function (th) {
        var w = prefs.anchos[th.getAttribute('data-columna')];
        if (w && th.offsetWidth) th.style.width = w + 'px';
        sum += w && th.offsetWidth ? w : th.offsetWidth;
      });
      table.style.width = sum + 'px';
    }

    Array.prototype.forEach.call(headRow.cells, function (th) {
      var grip = document.createElement('span');
      grip.className = 'col-ancho';
      grip.title = 'Arrastre para cambiar el ancho de la columna';
      th.appendChild(grip);
      grip.addEventListener('mousedown', function (ev) {
        ev.preventDefault();
        ev.stopPropagation();
        freeze();
        var startX = ev.clientX;
        var startW = th.offsetWidth;
        var startTable = table.offsetWidth;
        th.draggable = false;
        document.body.classList.add('ajustando-columna');
        function move(e) {
          var w = Math.max(MIN_WIDTH, startW + e.clientX - startX);
          th.style.width = w + 'px';
          table.style.width = startTable + w - startW + 'px';
        }
        function up() {
          document.removeEventListener('mousemove', move);
          document.removeEventListener('mouseup', up);
          document.body.classList.remove('ajustando-columna');
          th.draggable = movable;
          prefs.anchos = prefs.anchos || {};
          Array.prototype.forEach.call(headRow.cells, function (cell) {
            if (cell.offsetWidth) prefs.anchos[cell.getAttribute('data-columna')] = cell.offsetWidth;
          });
          save(key, prefs);
          showReset();
        }
        document.addEventListener('mousemove', move);
        document.addEventListener('mouseup', up);
      });
      grip.addEventListener('click', function (ev) { ev.stopPropagation(); });

      // --- Mover columnas (arrastrar el encabezado) -------------------
      if (!movable) return;
      th.draggable = true;
      th.classList.add('col-movible');
      th.addEventListener('dragstart', function (ev) {
        table._desde = Array.prototype.indexOf.call(headRow.cells, th);
        th.classList.add('col-arrastrando');
        try { ev.dataTransfer.effectAllowed = 'move'; ev.dataTransfer.setData('text/plain', th.getAttribute('data-columna')); } catch (e) { /* IE */ }
      });
      th.addEventListener('dragend', function () {
        table._desde = undefined;
        Array.prototype.forEach.call(headRow.cells, function (c) { c.classList.remove('col-arrastrando', 'col-destino'); });
      });
      th.addEventListener('dragover', function (ev) {
        if (table._desde === undefined) return;
        ev.preventDefault();
        th.classList.add('col-destino');
      });
      th.addEventListener('dragleave', function () { th.classList.remove('col-destino'); });
      th.addEventListener('drop', function (ev) {
        if (table._desde === undefined) return;
        ev.preventDefault();
        moveColumn(table._desde, Array.prototype.indexOf.call(headRow.cells, th));
        prefs.orden = names();
        save(key, prefs);
        showReset();
      });
    });

    // --- Pie: registros por pagina y restablecer ----------------------
    var foot = document.createElement('div');
    foot.className = 'tabla-pie';
    wrap.parentNode.insertBefore(foot, wrap.nextSibling);

    var reset = document.createElement('button');
    reset.type = 'button';
    reset.className = 'btn btn-link btn-sm p-0 tabla-restablecer';
    reset.textContent = 'Restablecer columnas';
    reset.title = 'Vuelve al orden y los anchos originales de esta tabla';
    reset.addEventListener('click', function () {
      delete prefs.orden;
      delete prefs.anchos;
      save(key, prefs);
      location.reload();
    });
    function showReset() { reset.hidden = !(prefs.orden || prefs.anchos); }

    var rows = body ? Array.prototype.filter.call(body.rows, function (r) { return r.cells.length === total; }) : [];
    var card = table.closest ? table.closest('.card') : null;
    var serverPaged = table.getAttribute('data-tabla') === 'servidor' || !!(card && card.querySelector('.pagination'));

    if (!serverPaged && rows.length > PAGER_FROM) {
      var size = SIZES.indexOf(Number(prefs.filas)) > -1 ? Number(prefs.filas) : DEFAULT_SIZE;
      var page = 0;

      // --- Filtros por columna -------------------------------------------
      // filters[nombre de columna] = valores que se muestran (null = todos).
      // Se identifican por nombre, no por posicion: siguen valiendo aunque
      // la columna se mueva.
      var filters = {};
      var EMPTY = '(vacío)';
      var cellText = function (row, name) {
        var cell = row.cells[names().indexOf(name)];
        var t = cell ? cell.textContent.replace(/\s+/g, ' ').trim() : '';
        return t === '' || t === '—' || t === '-' ? EMPTY : t;
      };
      var passes = function (row, except) {
        return Object.keys(filters).every(function (name) {
          return name === except || !filters[name] || filters[name].has(cellText(row, name));
        });
      };
      var activeCount = function () { return Object.keys(filters).filter(function (n) { return filters[n]; }).length; };
      var panel = null;
      var closePanel = function () {
        if (panel) { panel.remove(); panel = null; document.removeEventListener('mousedown', outside, true); }
      };
      var outside = function (ev) { if (panel && !panel.contains(ev.target) && !ev.target.closest('.col-filtro')) closePanel(); };
      var openPanel = function (th, button) {
        closePanel();
        var name = th.getAttribute('data-columna');
        // Valores posibles: los de las filas que pasan los OTROS filtros.
        var counts = {};
        rows.forEach(function (row) { if (passes(row, name)) { var v = cellText(row, name); counts[v] = (counts[v] || 0) + 1; } });
        var values = Object.keys(counts).sort(function (a, b) {
          if (a === EMPTY) return 1;
          if (b === EMPTY) return -1;
          return a.localeCompare(b, 'es', { numeric: true, sensitivity: 'base' });
        });
        var chosen = filters[name] ? new Set(filters[name]) : new Set(values);
        panel = document.createElement('div');
        panel.className = 'col-filtro-panel shadow';
        panel.setAttribute('role', 'dialog');
        panel.setAttribute('aria-label', 'Filtrar ' + name);
        var search = document.createElement('input');
        search.type = 'search';
        search.className = 'form-control form-control-sm mb-2';
        search.placeholder = 'Buscar en ' + name.replace(/#\d+$/, '') + '…';
        var tools = document.createElement('div');
        tools.className = 'd-flex gap-2 mb-1 small';
        var list = document.createElement('div');
        list.className = 'col-filtro-lista';
        var MAX = 400;
        var draw = function () {
          list.textContent = '';
          var term = search.value.trim().toLowerCase();
          var shown = values.filter(function (v) { return !term || v.toLowerCase().indexOf(term) > -1; });
          shown.slice(0, MAX).forEach(function (v) {
            var label = document.createElement('label');
            label.className = 'col-filtro-opcion';
            var box = document.createElement('input');
            box.type = 'checkbox';
            box.className = 'form-check-input me-2';
            box.checked = chosen.has(v);
            box.addEventListener('change', function () { if (box.checked) chosen.add(v); else chosen.delete(v); });
            var text = document.createElement('span');
            text.className = 'col-filtro-texto';
            text.textContent = v;
            var n = document.createElement('span');
            n.className = 'text-muted ms-auto ps-2';
            n.textContent = counts[v];
            label.appendChild(box);
            label.appendChild(text);
            label.appendChild(n);
            list.appendChild(label);
          });
          if (shown.length > MAX) {
            var more = document.createElement('div');
            more.className = 'small text-muted px-1';
            more.textContent = 'Y ' + (shown.length - MAX) + ' más: escriba para buscar.';
            list.appendChild(more);
          }
          if (!shown.length) {
            var none = document.createElement('div');
            none.className = 'small text-muted px-1';
            none.textContent = 'Ningún valor coincide.';
            list.appendChild(none);
          }
          return shown;
        };
        var link = function (text, fn) {
          var a = document.createElement('button');
          a.type = 'button';
          a.className = 'btn btn-link btn-sm p-0';
          a.textContent = text;
          a.addEventListener('click', fn);
          tools.appendChild(a);
        };
        link('Marcar todos', function () { draw().forEach(function (v) { chosen.add(v); }); draw(); });
        link('Ninguno', function () { draw().forEach(function (v) { chosen.delete(v); }); draw(); });
        var actions = document.createElement('div');
        actions.className = 'd-flex gap-2 mt-2';
        var apply = document.createElement('button');
        apply.type = 'button';
        apply.className = 'btn btn-sm btn-primary';
        apply.textContent = 'Aplicar';
        var clear = document.createElement('button');
        clear.type = 'button';
        clear.className = 'btn btn-sm btn-outline-secondary';
        clear.textContent = 'Quitar filtro';
        // Con buscar + Enter: muestra solo lo que coincide con lo escrito.
        search.addEventListener('keydown', function (ev) {
          if (ev.key === 'Enter') { ev.preventDefault(); var only = draw(); chosen = new Set(only); apply.click(); }
          if (ev.key === 'Escape') closePanel();
        });
        search.addEventListener('input', draw);
        apply.addEventListener('click', function () {
          filters[name] = chosen.size === values.length ? null : new Set(chosen);
          button.classList.toggle('activo', !!filters[name]);
          page = 0;
          closePanel();
          render();
        });
        clear.addEventListener('click', function () {
          filters[name] = null;
          button.classList.remove('activo');
          page = 0;
          closePanel();
          render();
        });
        actions.appendChild(apply);
        actions.appendChild(clear);
        panel.appendChild(search);
        panel.appendChild(tools);
        panel.appendChild(list);
        panel.appendChild(actions);
        document.body.appendChild(panel);
        draw();
        var r = button.getBoundingClientRect();
        var left = Math.min(r.left + window.scrollX, window.scrollX + document.documentElement.clientWidth - panel.offsetWidth - 8);
        panel.style.left = Math.max(window.scrollX + 8, left) + 'px';
        panel.style.top = (r.bottom + window.scrollY + 4) + 'px';
        search.focus();
        document.addEventListener('mousedown', outside, true);
      };
      Array.prototype.forEach.call(headRow.cells, function (th) {
        // Sin filtro: columnas sin titulo (acciones) o con una casilla (marcar todos).
        if (!th.getAttribute('data-columna') || th.querySelector('input') || !th.textContent.replace(/\s+/g, '').length) return;
        var button = document.createElement('button');
        button.type = 'button';
        button.className = 'col-filtro';
        button.title = 'Filtrar esta columna';
        button.setAttribute('aria-label', 'Filtrar ' + th.getAttribute('data-columna'));
        button.innerHTML = '<i class="bi bi-funnel"></i>';
        button.draggable = false;
        button.addEventListener('mousedown', function (ev) { ev.stopPropagation(); });
        button.addEventListener('click', function (ev) {
          ev.stopPropagation();
          ev.preventDefault();
          if (panel && panel.getAttribute('data-de') === th.getAttribute('data-columna')) { closePanel(); return; }
          openPanel(th, button);
          if (panel) panel.setAttribute('data-de', th.getAttribute('data-columna'));
        });
        th.appendChild(button);
      });

      var label = document.createElement('label');
      label.className = 'tabla-filas';
      label.appendChild(document.createTextNode('Mostrar '));
      var select = document.createElement('select');
      select.className = 'form-select form-select-sm';
      select.setAttribute('aria-label', 'Registros por página');
      SIZES.forEach(function (n) {
        var o = document.createElement('option');
        o.value = String(n);
        o.textContent = n ? String(n) : 'Todos';
        select.appendChild(o);
      });
      select.value = String(size);
      label.appendChild(select);
      label.appendChild(document.createTextNode(' registros'));

      var info = document.createElement('span');
      info.className = 'tabla-info text-muted';
      var prev = document.createElement('button');
      var next = document.createElement('button');
      [prev, next].forEach(function (b, i) {
        b.type = 'button';
        b.className = 'btn btn-sm btn-outline-secondary';
        b.textContent = i ? 'Siguiente' : 'Anterior';
      });

      var unfilter = document.createElement('button');
      unfilter.type = 'button';
      unfilter.className = 'btn btn-sm btn-outline-primary';
      unfilter.textContent = 'Quitar filtros';
      unfilter.addEventListener('click', function () {
        filters = {};
        Array.prototype.forEach.call(headRow.querySelectorAll('.col-filtro.activo'), function (b) { b.classList.remove('activo'); });
        page = 0;
        render();
      });

      var render = function () {
        var list = rows.filter(function (row) { return passes(row); });
        var per = size || list.length || 1;
        var pages = Math.max(Math.ceil(list.length / per), 1);
        page = Math.min(Math.max(page, 0), pages - 1);
        var from = page * per;
        var shown = new Set(list.slice(from, from + per));
        var changed = null;
        rows.forEach(function (row) {
          var hide = !shown.has(row);
          row.hidden = hide;
          if (!hide) return;
          // Lo marcado en una pagina que deja de verse (o que un filtro
          // oculta) se desmarca: una accion masiva no debe alcanzar filas
          // que no estan a la vista.
          Array.prototype.forEach.call(row.querySelectorAll('input[type="checkbox"]:checked'), function (cb) { cb.checked = false; changed = cb; });
        });
        if (changed) changed.dispatchEvent(new Event('change', { bubbles: true }));
        var filtered = activeCount() > 0;
        info.textContent = list.length
          ? (from + 1) + '–' + Math.min(from + per, list.length) + ' de ' + list.length + (filtered ? ' (filtrado de ' + rows.length + ')' : '')
          : 'Ningún registro con estos filtros (de ' + rows.length + ')';
        unfilter.hidden = !filtered;
        prev.disabled = page === 0;
        next.disabled = page >= pages - 1;
        prev.hidden = next.hidden = pages === 1;
      };
      select.addEventListener('change', function () {
        size = Number(select.value);
        page = 0;
        prefs.filas = size;
        save(key, prefs);
        render();
      });
      prev.addEventListener('click', function () { page -= 1; render(); });
      next.addEventListener('click', function () { page += 1; render(); });
      foot.appendChild(label);
      foot.appendChild(info);
      foot.appendChild(unfilter);
      foot.appendChild(prev);
      foot.appendChild(next);
      render();
    }
    foot.appendChild(reset);
    showReset();
    applyWidths();
  }

  function init() {
    // Una tabla de listado que no venia dentro de un contenedor con
    // desplazamiento lo recibe aqui: al estirar columnas puede crecer mas
    // que la pagina.
    Array.prototype.forEach.call(document.querySelectorAll('table.table'), function (table) {
      if (!table.tHead || table.getAttribute('data-tabla') === 'no' || table.parentNode.classList.contains('table-responsive')) return;
      var wrap = document.createElement('div');
      wrap.className = 'table-responsive';
      table.parentNode.insertBefore(wrap, table);
      wrap.appendChild(table);
    });
    Array.prototype.forEach.call(document.querySelectorAll('.table-responsive > table'), setup);
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
