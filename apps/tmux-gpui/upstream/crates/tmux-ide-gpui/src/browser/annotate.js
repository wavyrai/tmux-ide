// Herdr GPUI's annotation picker. The app evaluates this in the page's main
// frame when annotating starts, passing the numbered notes already queued.
// It only reports what the user picks: an element, a text selection, or a
// region drawn over the page. The notes themselves are written in the app,
// where the page cannot read them. Everything it posts is treated as
// untrusted by the app, and nothing reaches an agent until the user sends.
(function (markers) {
  "use strict";
  var previous = window.__herdrAnnotate;
  // Markers already on screen before this run keep still; only a newly
  // numbered one pops in.
  var popped = previous && typeof previous.popped === "number" ? previous.popped : 0;
  if (previous && typeof previous.disarm === "function") {
    try { previous.disarm(); } catch (_) {}
  }
  var post = function (message) {
    try { window.ipc.postMessage(JSON.stringify(message)); } catch (_) {}
  };

  var host = document.createElement("div");
  host.style.cssText =
    "position:fixed;inset:0;z-index:2147483647;pointer-events:none;margin:0;padding:0;border:0";
  var root = host.attachShadow({ mode: "closed" });
  // A constant skeleton: page text only ever goes in through textContent.
  root.innerHTML =
    "<style>" +
    ".box{position:fixed;border:2px solid #0d99ff;background:rgba(13,153,255,.08);border-radius:2px;display:none}" +
    ".box.region{border-style:dashed;background:rgba(13,153,255,.12)}" +
    ".label{position:fixed;background:#0d99ff;color:#fff;font:11px/16px -apple-system,system-ui,sans-serif;padding:0 6px;border-radius:3px;display:none;white-space:nowrap}" +
    ".mark{position:fixed;border:2px dashed #f59e0b;border-radius:2px}" +
    ".pin{position:fixed;min-width:18px;height:18px;padding:0 4px;box-sizing:border-box;border-radius:9px;background:#f59e0b;color:#111;font:bold 11px/18px -apple-system,system-ui,sans-serif;text-align:center;box-shadow:0 1px 3px rgba(0,0,0,.4)}" +
    "@keyframes herdr-pop{from{transform:scale(.2);opacity:0}to{transform:scale(1);opacity:1}}" +
    "@keyframes herdr-fade{from{opacity:0}to{opacity:1}}" +
    "@media (prefers-reduced-motion:no-preference){.pin.new{animation:herdr-pop .26s cubic-bezier(.2,1.5,.4,1)}.mark.new{animation:herdr-fade .22s ease-out}}" +
    "</style><div class=box></div><div class=label></div><div class=marks></div>";
  var box = root.querySelector(".box");
  var label = root.querySelector(".label");
  var marks = root.querySelector(".marks");
  document.documentElement.appendChild(host);

  var ownsNode = function (node) {
    return node === host || host.contains(node);
  };

  // A path of tag:nth-of-type steps from <body>, or from the nearest
  // element with a unique id.
  var selectorOf = function (element) {
    var steps = [];
    for (var node = element; node && node.nodeType === 1 && node !== document.documentElement; node = node.parentElement) {
      if (node.id && window.CSS && CSS.escape) {
        var byId = "#" + CSS.escape(node.id);
        try {
          if (document.querySelectorAll(byId).length === 1) {
            steps.unshift(byId);
            break;
          }
        } catch (_) {}
      }
      var tag = node.tagName.toLowerCase();
      if (node === document.body) {
        steps.unshift("body");
        break;
      }
      var index = 1;
      for (var sibling = node.previousElementSibling; sibling; sibling = sibling.previousElementSibling) {
        if (sibling.tagName === node.tagName) index += 1;
      }
      steps.unshift(tag + ":nth-of-type(" + index + ")");
    }
    return steps.join(" > ");
  };

  var textOf = function (element, limit) {
    return String(element.innerText || element.textContent || "").replace(/\s+/g, " ").trim().slice(0, limit);
  };

  // The visible part of a rectangle, which is what a screenshot can show.
  var visible = function (rect) {
    var left = Math.max(0, rect.left);
    var top = Math.max(0, rect.top);
    var right = Math.min(window.innerWidth, rect.right);
    var bottom = Math.min(window.innerHeight, rect.bottom);
    if (right - left < 1 || bottom - top < 1) return null;
    return { x: left, y: top, width: right - left, height: bottom - top };
  };

  var elementAt = function (x, y) {
    var element = document.elementFromPoint(x, y);
    return element && !ownsNode(element) ? element : null;
  };

  var place = function (node, left, top, width, height) {
    node.style.left = left + "px";
    node.style.top = top + "px";
    if (width !== undefined) node.style.width = width + "px";
    if (height !== undefined) node.style.height = height + "px";
  };

  var hovered = null;
  var showBox = function (element) {
    hovered = element;
    box.className = "box";
    if (!element) {
      box.style.display = "none";
      label.style.display = "none";
      return;
    }
    var rect = element.getBoundingClientRect();
    place(box, rect.left, rect.top, rect.width, rect.height);
    box.style.display = "block";
    label.textContent = element.tagName.toLowerCase() + "  " + Math.round(rect.width) + "×" + Math.round(rect.height);
    place(label, Math.max(0, rect.left), rect.top >= 20 ? rect.top - 18 : rect.bottom + 2);
    label.style.display = "block";
  };

  var drawMarkers = function () {
    marks.textContent = "";
    var highest = 0;
    markers.forEach(function (marker) {
      var fresh = marker.number > popped;
      highest = Math.max(highest, marker.number);
      var rect = null;
      if (marker.rect) {
        rect = {
          left: marker.rect.x - window.scrollX,
          top: marker.rect.y - window.scrollY,
          width: marker.rect.width,
          height: marker.rect.height,
        };
      } else {
        var element = null;
        try { element = marker.selector ? document.querySelector(marker.selector) : null; } catch (_) {}
        if (!element) return;
        rect = element.getBoundingClientRect();
      }
      var mark = document.createElement("div");
      mark.className = fresh ? "mark new" : "mark";
      place(mark, rect.left, rect.top, rect.width, rect.height);
      var pin = document.createElement("div");
      pin.className = fresh ? "pin new" : "pin";
      pin.textContent = String(marker.number);
      place(pin, Math.max(0, rect.left - 9), Math.max(0, rect.top - 9));
      marks.appendChild(mark);
      marks.appendChild(pin);
    });
    // Sent or cleared notes number again from one, and pop again.
    popped = highest;
  };
  var frame = 0;
  var redraw = function () {
    if (frame) return;
    frame = requestAnimationFrame(function () {
      frame = 0;
      drawMarkers();
      if (hovered) showBox(hovered);
    });
  };

  // The overlay stays out of the screenshot the app takes of a pick, and
  // comes back when the app says so, or on its own if it never does.
  var hideTimer = 0;
  var conceal = function () {
    host.style.visibility = "hidden";
    clearTimeout(hideTimer);
    hideTimer = setTimeout(function () { host.style.visibility = ""; }, 2000);
  };
  var reveal = function () {
    clearTimeout(hideTimer);
    host.style.visibility = "";
  };

  // What a region covers: the topmost element at points across it, their
  // closest shared container, and their text.
  var covering = function (rect) {
    var seen = [];
    var steps = 5;
    for (var row = 0; row < steps; row += 1) {
      for (var column = 0; column < steps; column += 1) {
        var x = rect.x + (rect.width * (column + 0.5)) / steps;
        var y = rect.y + (rect.height * (row + 0.5)) / steps;
        var element = elementAt(x, y);
        if (element && element !== document.documentElement && seen.indexOf(element) < 0) seen.push(element);
      }
    }
    var container = seen[0] || document.body;
    var containsAll = function (candidate) {
      return seen.every(function (element) { return candidate.contains(element); });
    };
    while (container && container !== document.body && !containsAll(container)) {
      container = container.parentElement;
    }
    var texts = [];
    var covers = seen.slice(0, 8).map(function (element) {
      var text = textOf(element, 120);
      if (text && texts.indexOf(text) < 0) texts.push(text);
      return { selector: selectorOf(element), tag: element.tagName.toLowerCase(), text: text };
    });
    return {
      container: container ? selectorOf(container) : "body",
      covers: covers,
      text: texts.join(" | ").slice(0, 600),
    };
  };

  var mode = "pick";
  var drawing = null;
  var swallow = function (event) {
    event.preventDefault();
    event.stopPropagation();
    event.stopImmediatePropagation();
  };
  var drawnRect = function (event) {
    var left = Math.min(drawing.x, event.clientX);
    var top = Math.min(drawing.y, event.clientY);
    return {
      left: left,
      top: top,
      right: Math.max(drawing.x, event.clientX),
      bottom: Math.max(drawing.y, event.clientY),
    };
  };
  var onMove = function (event) {
    if (drawing) {
      var rect = drawnRect(event);
      box.className = "box region";
      place(box, rect.left, rect.top, rect.right - rect.left, rect.bottom - rect.top);
      box.style.display = "block";
      label.textContent = Math.round(rect.right - rect.left) + "×" + Math.round(rect.bottom - rect.top);
      place(label, Math.max(0, rect.left), rect.top >= 20 ? rect.top - 18 : rect.bottom + 2);
      label.style.display = "block";
      swallow(event);
      return;
    }
    if (mode === "region") {
      showBox(null);
      return;
    }
    showBox(elementAt(event.clientX, event.clientY));
  };
  // A region starts on a press in region mode, or on a Shift-press. Text
  // selection needs the default press, so other presses only stop reaching
  // the page's own handlers; clicks are swallowed so links do not follow.
  var onPress = function (event) {
    if (event.button === 0 && (mode === "region" || event.shiftKey)) {
      drawing = drawing || { x: event.clientX, y: event.clientY };
      event.stopPropagation();
      event.stopImmediatePropagation();
      // Cancelling the pointer press would also cancel the mouse events that
      // follow it, so only the mouse press is cancelled, which is what keeps
      // the drag from selecting text.
      if (event.type === "mousedown") event.preventDefault();
      return;
    }
    event.stopPropagation();
    event.stopImmediatePropagation();
  };
  var onRelease = function (event) {
    if (event.button !== 0) return;
    if (drawing) {
      var drawn = drawnRect(event);
      drawing = null;
      swallow(event);
      showBox(null);
      var rect = visible(drawn);
      if (!rect || rect.width < 6 || rect.height < 6) return;
      var found = covering(rect);
      conceal();
      post({
        kind: "pick",
        target: {
          kind: "region",
          rect: rect,
          scroll: { x: window.scrollX, y: window.scrollY },
          viewport: { width: window.innerWidth, height: window.innerHeight },
          container: found.container,
          covers: found.covers,
          text: found.text,
        },
      });
      return;
    }
    event.stopPropagation();
    event.stopImmediatePropagation();
    var selection = window.getSelection();
    var quote = selection && !selection.isCollapsed ? String(selection).replace(/\s+/g, " ").trim() : "";
    if (quote) {
      var range = selection.getRangeAt(0);
      var node = range.commonAncestorContainer;
      var element = node.nodeType === 1 ? node : node.parentElement;
      if (element && !ownsNode(element)) {
        var shot = visible(range.getBoundingClientRect());
        conceal();
        post({
          kind: "pick",
          target: {
            kind: "selection",
            selector: selectorOf(element),
            tag: element.tagName.toLowerCase(),
            quote: quote.slice(0, 1000),
            rect: shot,
          },
        });
      }
      return;
    }
    if (mode === "region") return;
    var picked = elementAt(event.clientX, event.clientY);
    if (!picked) return;
    var pickedRect = visible(picked.getBoundingClientRect());
    showBox(null);
    conceal();
    post({
      kind: "pick",
      target: {
        kind: "element",
        selector: selectorOf(picked),
        tag: picked.tagName.toLowerCase(),
        text: textOf(picked, 400),
        html: String(picked.outerHTML || "").slice(0, 2000),
        rect: pickedRect,
      },
    });
  };
  var onKey = function (event) {
    if (event.key === "Escape") {
      swallow(event);
      if (drawing) {
        drawing = null;
        showBox(null);
        return;
      }
      post({ kind: "cancel" });
    }
  };

  var listeners = [
    ["mousemove", onMove],
    ["mousedown", onPress],
    ["pointerdown", onPress],
    ["mouseup", onRelease],
    ["click", swallow],
    ["dblclick", swallow],
    ["auxclick", swallow],
    ["submit", swallow],
    ["dragstart", swallow],
    ["keydown", onKey],
  ];
  listeners.forEach(function (entry) { window.addEventListener(entry[0], entry[1], true); });
  window.addEventListener("scroll", redraw, true);
  window.addEventListener("resize", redraw, true);
  drawMarkers();

  window.__herdrAnnotate = {
    get popped() { return popped; },
    disarm: function () {
      listeners.forEach(function (entry) { window.removeEventListener(entry[0], entry[1], true); });
      window.removeEventListener("scroll", redraw, true);
      window.removeEventListener("resize", redraw, true);
      if (frame) cancelAnimationFrame(frame);
      clearTimeout(hideTimer);
      if (mode === "region") document.documentElement.style.cursor = "";
      host.remove();
      if (window.__herdrAnnotate && window.__herdrAnnotate.host === host) delete window.__herdrAnnotate;
    },
    reveal: reveal,
    mode: function (next) {
      mode = next === "region" ? "region" : "pick";
      drawing = null;
      showBox(null);
      document.documentElement.style.cursor = mode === "region" ? "crosshair" : "";
    },
    host: host,
  };
})
