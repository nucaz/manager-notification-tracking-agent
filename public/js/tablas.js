// Tablas de listado de toda la aplicacion: cuantos registros mostrar,
// filtros por columna (como en Excel: se marcan los valores a mostrar),
// columnas que se pueden estirar y cambiar de lugar. Se aplica solo, a toda
// tabla con encabezado que este dentro de un .table-responsive; lo que cada
// persona ajusta se recuerda en su navegador, por pantalla y por tabla.
//
// Ordenar: clic en el encabezado (ascendente, descendente, orden original).
// Numeros, montos y fechas (DD/MM/AAAA o AAAA-MM-DD) se ordenan como tales;
// una celda puede dar su valor de orden con data-valor. Un encabezado con
// data-orden="no" no ordena.
//
// Para dejar una tabla como esta: <table data-tabla="no">.
// Una tabla que ya pagina en el servidor (trae su propio .pagination en la
// misma tarjeta, o data-tabla="servidor") conserva su paginacion: ordena y
// filtra en el servidor, sobre todos los registros, cuando sus encabezados
// lo declaran:
//   data-orden="clave"          -> ?orden=clave&dir=asc|desc
//   data-filtro="param" data-opciones='[["valor","texto"],...]'
//                               -> ?param=valor1,valor2 (marcar valores)
//   data-filtro-texto="param"   -> ?param=texto (contiene)
(function () {
  'use strict';

  var SIZES = [10, 20, 30, 40, 50, 100, 0]; // 0 = todos
  var DEFAULT_SIZE = 50;
  var MIN_WIDTH = 48;
  var PAGER_FROM = 10; // con 10 filas o menos no hace falta paginar

  // ---- valor de orden de una celda: numero, fecha o texto -------------
  var DATE_DMY = /^(\d{1,2})\/(\d{1,2})\/(\d{4})(?:[ ,T]+(\d{1,2}):(\d{2})(?::(\d{2}))?)?$/;
  var DATE_YMD = /^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{2}):(\d{2})(?::(\d{2}))?)?/;
  function dateKey(y, m, d, hh, mm, ss) {
    return ((((Number(y) * 100 + Number(m)) * 100 + Number(d)) * 100 + Number(hh || 0)) * 100 + Number(mm || 0)) * 100 + Number(ss || 0);
  }
  function sortValue(cell) {
    if (!cell) return null;
    var raw = cell.getAttribute('data-valor');
    var t = (raw !== null ? raw : cell.textContent).replace(/\s+/g, ' ').trim();
    if (t === '' || t === '—' || t === '-') return null;
    var m = t.match(DATE_YMD);
    if (m) return dateKey(m[1], m[2], m[3], m[4], m[5], m[6]);
    m = t.match(DATE_DMY);
    if (m) return dateKey(m[3], m[2], m[1], m[4], m[5], m[6]);
    var n = t.replace(/^(S\/|US\$|\$|€)\s*/i, '').replace(/\s*%$/, '');
    if (/^-?\d{1,3}(,\d{3})+(\.\d+)?$/.test(n)) n = n.replace(/,/g, '');
    else if (/^-?\d+,\d+$/.test(n)) n = n.replace(',', '.');
    if (/^-?\d+(\.\d+)?$/.test(n)) return Number(n);
    return t;
  }
  function compareValues(a, b) {
    if (a === null && b === null) return 0;
    if (a === null) return 1; // vacios al final, en ambos sentidos
    if (b === null) return -1;
    if (typeof a === 'number' && typeof b === 'number') return a - b;
    if (typeof a === 'number') return -1;
    if (typeof b === 'number') return 1;
    return a.localeCompare(b, 'es', { numeric: true, sensitivity: 'base' });
  }

  function orderIcon(th) {
    var icon = th.querySelector('.col-orden');
    if (!icon) {
      icon = document.createElement('span');
      icon.className = 'col-orden';
      icon.setAttribute('aria-hidden', 'true');
      th.appendChild(icon);
    }
    return icon;
  }
  function showOrder(th, dir) {
    var icon = orderIcon(th);
    icon.innerHTML = dir === 'asc' ? '<i class="bi bi-sort-up"></i>' : dir === 'desc' ? '<i class="bi bi-sort-down"></i>' : '<i class="bi bi-arrow-down-up"></i>';
    icon.classList.toggle('activo', !!dir);
    th.setAttribute('aria-sort', dir === 'asc' ? 'ascending' : dir === 'desc' ? 'descending' : 'none');
  }
  // Un clic que viene de arrastrar la columna, estirarla o de un control
  // dentro del encabezado no ordena.
  function headerClickOk(table, ev) {
    if (ev.target.closest('.col-filtro, .col-ancho, a, button, input, select, label')) return false;
    return !(table._arrastre && Date.now() - table._arrastre < 400);
  }

  // ---- panel de filtro de una tabla paginada en el servidor -------------
  function serverPanel(th, button, params, apply) {
    var old = document.querySelector('.col-filtro-panel');
    if (old) { old.remove(); if (old.getAttribute('data-de') === th.getAttribute('data-columna')) return; }
    var title = th.getAttribute('data-columna').replace(/#\d+$/, '');
    var panel = document.createElement('div');
    panel.className = 'col-filtro-panel shadow';
    panel.setAttribute('role', 'dialog');
    panel.setAttribute('aria-label', 'Filtrar ' + title);
    panel.setAttribute('data-de', th.getAttribute('data-columna'));
    var close = function () { panel.remove(); document.removeEventListener('mousedown', outside, true); };
    var outside = function (ev) { if (!panel.contains(ev.target) && !ev.target.closest('.col-filtro')) close(); };
    var actions = document.createElement('div');
    actions.className = 'd-flex gap-2 mt-2';
    var ok = document.createElement('button');
    ok.type = 'button';
    ok.className = 'btn btn-sm btn-primary';
    ok.textContent = 'Aplicar';
    var clear = document.createElement('button');
    clear.type = 'button';
    clear.className = 'btn btn-sm btn-outline-secondary';
    clear.textContent = 'Quitar filtro';
    var textParam = th.getAttribute('data-filtro-texto');
    var getValue;
    if (textParam) {
      var input = document.createElement('input');
      input.type = 'search';
      input.className = 'form-control form-control-sm';
      input.placeholder = title + ' contiene…';
      input.value = params.get(textParam) || '';
      input.addEventListener('keydown', function (ev) {
        if (ev.key === 'Enter') { ev.preventDefault(); ok.click(); }
        if (ev.key === 'Escape') close();
      });
      panel.appendChild(input);
      getValue = function () { return input.value.trim(); };
      setTimeout(function () { input.focus(); }, 0);
    } else {
      var param = th.getAttribute('data-filtro');
      var options = [];
      try { options = JSON.parse(th.getAttribute('data-opciones') || '[]'); } catch (e) { options = []; }
      var current = (params.get(param) || '').split(',').filter(Boolean);
      var search = document.createElement('input');
      search.type = 'search';
      search.className = 'form-control form-control-sm mb-2';
      search.placeholder = 'Buscar en ' + title + '…';
      var tools = document.createElement('div');
      tools.className = 'd-flex gap-2 mb-1 small';
      var list = document.createElement('div');
      list.className = 'col-filtro-lista';
      var boxes = [];
      options.forEach(function (o) {
        var label = document.createElement('label');
        label.className = 'col-filtro-opcion';
        var box = document.createElement('input');
        box.type = 'checkbox';
        box.className = 'form-check-input me-2';
        box.value = String(o[0]);
        box.checked = !current.length || current.indexOf(String(o[0])) > -1;
        var text = document.createElement('span');
        text.className = 'col-filtro-texto';
        text.textContent = o[1];
        label.appendChild(box);
        label.appendChild(text);
        list.appendChild(label);
        boxes.push({ box: box, label: label, text: String(o[1]).toLowerCase() });
      });
      var visible = function () { return boxes.filter(function (b) { return !b.label.hidden; }); };
      search.addEventListener('input', function () {
        var term = search.value.trim().toLowerCase();
        boxes.forEach(function (b) { b.label.hidden = !!term && b.text.indexOf(term) === -1; });
      });
      search.addEventListener('keydown', function (ev) {
        if (ev.key === 'Enter') { ev.preventDefault(); boxes.forEach(function (b) { b.box.checked = !b.label.hidden; }); ok.click(); }
        if (ev.key === 'Escape') close();
      });
      [['Marcar todos', true], ['Ninguno', false]].forEach(function (x) {
        var a = document.createElement('button');
        a.type = 'button';
        a.className = 'btn btn-link btn-sm p-0';
        a.textContent = x[0];
        a.addEventListener('click', function () { visible().forEach(function (b) { b.box.checked = x[1]; }); });
        tools.appendChild(a);
      });
      panel.appendChild(search);
      panel.appendChild(tools);
      panel.appendChild(list);
      getValue = function () {
        var chosen = boxes.filter(function (b) { return b.box.checked; }).map(function (b) { return b.box.value; });
        return chosen.length === boxes.length || !chosen.length ? '' : chosen.join(',');
      };
      setTimeout(function () { search.focus(); }, 0);
    }
    ok.addEventListener('click', function () { apply(textParam || th.getAttribute('data-filtro'), getValue()); });
    clear.addEventListener('click', function () { apply(textParam || th.getAttribute('data-filtro'), ''); });
    actions.appendChild(ok);
    actions.appendChild(clear);
    panel.appendChild(actions);
    document.body.appendChild(panel);
    var r = button.getBoundingClientRect();
    var left = Math.min(r.left + window.scrollX, window.scrollX + document.documentElement.clientWidth - panel.offsetWidth - 8);
    panel.style.left = Math.max(window.scrollX + 8, left) + 'px';
    panel.style.top = (r.bottom + window.scrollY + 4) + 'px';
    document.addEventListener('mousedown', outside, true);
  }

  // Orden y filtros de una tabla paginada en el servidor: cambian la URL.
  function setupServer(table, headRow) {
    var params = new URLSearchParams(location.search);
    var pOrden = table.getAttribute('data-param-orden') || 'orden';
    var pDir = table.getAttribute('data-param-dir') || 'dir';
    var pPagina = table.getAttribute('data-param-pagina') || 'pagina';
    // Cada accion parte de la URL actual (copia) y vuelve a la pagina 1.
    var go = function (change) {
      var next = new URLSearchParams(location.search);
      change(next);
      next.delete(pPagina);
      var s = next.toString();
      location.href = location.pathname + (s ? '?' + s : '');
    };
    Array.prototype.forEach.call(headRow.cells, function (th) {
      var key = th.getAttribute('data-orden');
      if (key && key !== 'no') {
        th.classList.add('col-ordenable');
        var active = params.get(pOrden) === key;
        showOrder(th, active ? (params.get(pDir) === 'desc' ? 'desc' : 'asc') : '');
        th.title = 'Clic para ordenar por esta columna';
        th.addEventListener('click', function (ev) {
          if (!headerClickOk(table, ev)) return;
          var first = th.getAttribute('data-orden-inicial') === 'desc' ? 'desc' : 'asc';
          var dir = active ? (params.get(pDir) === 'desc' ? 'desc' : 'asc') : '';
          go(function (next) {
            if (!dir) { next.set(pOrden, key); next.set(pDir, first); }
            else if (dir === first) { next.set(pOrden, key); next.set(pDir, first === 'asc' ? 'desc' : 'asc'); }
            else { next.delete(pOrden); next.delete(pDir); }
          });
        });
      }
      var fParam = th.getAttribute('data-filtro') || th.getAttribute('data-filtro-texto');
      if (!fParam) return;
      var button = document.createElement('button');
      button.type = 'button';
      button.className = 'col-filtro' + (params.get(fParam) ? ' activo' : '');
      button.title = 'Filtrar esta columna';
      button.setAttribute('aria-label', 'Filtrar ' + th.getAttribute('data-columna'));
      button.innerHTML = '<i class="bi bi-funnel"></i>';
      button.draggable = false;
      button.addEventListener('mousedown', function (ev) { ev.stopPropagation(); });
      button.addEventListener('click', function (ev) {
        ev.stopPropagation();
        ev.preventDefault();
        serverPanel(th, button, params, function (param, value) {
          go(function (next) { if (value) next.set(param, value); else next.delete(param); });
        });
      });
      th.appendChild(button);
    });
  }

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
          table._arrastre = Date.now();
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
        table._arrastre = Date.now();
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

    // --- Ordenar ---------------------------------------------------------
    if (serverPaged) {
      setupServer(table, headRow);
    } else if (rows.length > 1) {
      var original = rows.slice();
      var originalAll = Array.prototype.slice.call(body.rows); // incluye filas de totales u otras
      var sortState = prefs.ordenar && prefs.ordenar.col ? prefs.ordenar : null;
      var sortable = function (th) {
        return th.getAttribute('data-orden') !== 'no' && !th.querySelector('input') && th.textContent.replace(/\s+/g, '').length > 0;
      };
      var applySort = function (initial) {
        var idx = sortState ? names().indexOf(sortState.col) : -1;
        if (idx === -1) sortState = null;
        var sorted = original.slice();
        if (!sortState) {
          // Sin orden: al cargar no se toca nada; al quitarlo, todo vuelve a su lugar.
          if (!initial) originalAll.forEach(function (row) { body.appendChild(row); });
        } else {
          var desc = sortState.dir === 'desc';
          sorted = original.map(function (row, i) { return { row: row, i: i, v: sortValue(row.cells[idx]) }; })
            .sort(function (a, b) {
              var c = compareValues(a.v, b.v);
              if (desc && a.v !== null && b.v !== null) c = -c;
              return c || a.i - b.i;
            })
            .map(function (k) { return k.row; });
        }
        if (sortState) {
          sorted.forEach(function (row) { body.appendChild(row); });
          originalAll.forEach(function (row) { if (original.indexOf(row) === -1) body.appendChild(row); });
        }
        rows.length = 0;
        Array.prototype.push.apply(rows, sorted);
        Array.prototype.forEach.call(headRow.cells, function (th) {
          if (sortable(th)) showOrder(th, sortState && sortState.col === th.getAttribute('data-columna') ? sortState.dir : '');
        });
      };
      Array.prototype.forEach.call(headRow.cells, function (th) {
        if (!sortable(th)) return;
        th.classList.add('col-ordenable');
        th.title = 'Clic para ordenar; arrastre para mover la columna';
        th.addEventListener('click', function (ev) {
          if (!headerClickOk(table, ev)) return;
          var col = th.getAttribute('data-columna');
          if (!sortState || sortState.col !== col) sortState = { col: col, dir: 'asc' };
          else if (sortState.dir === 'asc') sortState = { col: col, dir: 'desc' };
          else sortState = null;
          if (sortState) prefs.ordenar = sortState; else delete prefs.ordenar;
          save(key, prefs);
          applySort();
          if (typeof render === 'function') { page = 0; render(); }
        });
      });
      applySort(true);
    }

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
