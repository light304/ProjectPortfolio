// ---------------------------------------------
// 1. Core solver: find optimal hexagon count/width
//    for a given viewport width, constrained to
//    [minWidth, maxWidth], closest to target.
// ---------------------------------------------
function getOptimalHexGrid(viewportWidth, minWidth = 60, maxWidth = 100, target = 80) {
  const minCount = Math.ceil(viewportWidth / maxWidth);
  const maxCount = Math.floor(viewportWidth / minWidth);

  let best = null;

  for (let n = minCount; n <= maxCount; n++) {
    const hexWidth = viewportWidth / n;
    const diff = Math.abs(hexWidth - target);

    if (!best || diff < best.diff) {
      best = { count: n, hexWidth, diff };
    }
  }

  // Fallback if no integer n keeps hexWidth in range
  if (!best) {
    const n = Math.round(viewportWidth / target);
    best = { count: n, hexWidth: viewportWidth / n, diff: null, fallback: true };
  }

  return best;
}

// ---------------------------------------------
// 2. Pointy-top hexagon geometry helpers
//    width  = sqrt(3) * size
//    height = 2 * size
// ---------------------------------------------
function hexCorner(cx, cy, size, i) {
  const angleDeg = 60 * i - 30; // pointy-top offset
  const angleRad = (Math.PI / 180) * angleDeg;
  return [cx + size * Math.cos(angleRad), cy + size * Math.sin(angleRad)];
}

function drawHex(ctx, cx, cy, size) {
  ctx.beginPath();
  for (let i = 0; i < 6; i++) {
    const [x, y] = hexCorner(cx, cy, size, i);
    if (i === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  }
  ctx.closePath();
  ctx.stroke();
}

// Fills a hex path with no stroke — used for every hex that's "in use"
// (gradient column + highlight edges). No border, just color.
function fillHex(ctx, cx, cy, size, fillStyle) {
  ctx.beginPath();
  for (let i = 0; i < 6; i++) {
    const [x, y] = hexCorner(cx, cy, size, i);
    if (i === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  }
  ctx.closePath();
  ctx.fillStyle = fillStyle;
  ctx.fill();
}

// ---------------------------------------------
// Color interpolation for the gradient column.
// Reads two hex colors ("#rrggbb") and blends them
// by t (0 -> colorA, 1 -> colorB).
// ---------------------------------------------
function hexToRgb(hex) {
  const n = parseInt(hex.replace('#', ''), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

function lerpColor(hexA, hexB, t) {
  const [r1, g1, b1] = hexToRgb(hexA);
  const [r2, g2, b2] = hexToRgb(hexB);
  const r = Math.round(r1 + (r2 - r1) * t);
  const g = Math.round(g1 + (g2 - g1) * t);
  const b = Math.round(b1 + (b2 - b1) * t);
  return `rgb(${r}, ${g}, ${b})`;
}

// Inverts an "rgb(r, g, b)" string — used when hovering a hex
// that's already part of the gradient/highlight/fill system.
function invertColor(rgbStr) {
  const [r, g, b] = rgbStr.match(/\d+/g).map(Number);
  return `rgb(${255 - r}, ${255 - g}, ${255 - b})`;
}

// ---------------------------------------------
// Edge detection: find hexagons sitting on the
// boundary of any element tagged [data-hex-highlight].
// ---------------------------------------------

// Bounding box of an element in DOCUMENT coordinates
// (not viewport coordinates — accounts for scroll,
// since our canvas covers the whole page).
function getDocRect(el) {
  const r = el.getBoundingClientRect();
  const scrollX = window.scrollX || window.pageXOffset;
  const scrollY = window.scrollY || window.pageYOffset;
  return {
    left: r.left + scrollX,
    right: r.right + scrollX,
    top: r.top + scrollY,
    bottom: r.bottom + scrollY
  };
}

// Distance from a point to the nearest edge of a rect.
// Returns 0 if the point sits exactly on the boundary.
// Works whether the point is inside or outside the rect.
function distanceToRectEdge(px, py, rect) {
  const dx = Math.max(rect.left - px, 0, px - rect.right);
  const dy = Math.max(rect.top - py, 0, py - rect.bottom);

  if (dx === 0 && dy === 0) {
    // point is inside the rect — distance to the nearest wall
    return Math.min(px - rect.left, rect.right - px, py - rect.top, rect.bottom - py);
  }
  return Math.sqrt(dx * dx + dy * dy);
}

function isHexOnRectEdge(cx, cy, threshold, rect) {
  return distanceToRectEdge(cx, cy, rect) <= threshold;
}

// True if a point sits fully inside a rect (used for data-hex-fill,
// where we want the whole interior colored in, not just the edge band).
function isPointInRect(px, py, rect) {
  return px >= rect.left && px <= rect.right && py >= rect.top && py <= rect.bottom;
}

// ---------------------------------------------
// 3. Build + render the full-page tessellation
// ---------------------------------------------
const canvas = document.getElementById('hexCanvas');
const ctx = canvas.getContext('2d');
const hoverCanvas = document.getElementById('hexHoverCanvas');
const hoverCtx = hoverCanvas.getContext('2d');
const statsEl = document.getElementById('stats');

// Mouse position in DOCUMENT coordinates (not viewport),
// so it lines up with the same coordinate space the grid is drawn in.
const mouse = { x: null, y: null };

// Cached geometry/state from the last full grid render. Hover reads
// from this instead of recomputing the grid, so mouse movement never
// triggers a full-page redraw — only a single hex gets touched.
let gridState = null;

function renderGrid() {
  const viewportWidth = window.innerWidth;
  const docHeight = document.body.scrollHeight;

  const grid = getOptimalHexGrid(viewportWidth, 60, 100, 80);
  const size = grid.hexWidth / Math.sqrt(3); // circumradius from width
  const hexWidth = grid.hexWidth;
  const hexHeight = size * 2;
  const vertStep = hexHeight * 0.75;

  // size canvas to full document
  canvas.width = viewportWidth;
  canvas.height = docHeight;
  canvas.style.height = docHeight + 'px';

  hoverCanvas.width = viewportWidth;
  hoverCanvas.height = docHeight;
  hoverCanvas.style.height = docHeight + 'px';

  ctx.clearRect(0, 0, canvas.width, canvas.height);

  const rows = Math.ceil(docHeight / vertStep) + 2;

  // The last "real" column before the right-hand edge.
  // Columns run 0 .. grid.count-1 across the exact viewport width,
  // so grid.count - 1 is one hex in from the edge.
  const targetCol = grid.count - 1;

  // Shared gradient scale — used by BOTH the right-hand column
  // and any highlighted container edges, so color always reflects
  // the same position down the page regardless of which one it's on.
  const colorTop = '#1b4332';    // deep forest green
  const colorBottom = '#EF9F27'; // amber

  // Two flavors of tagged element:
  // - data-hex-highlight: only the edge band lights up (pure outline)
  // - data-hex-fill:      edge band AND the full interior light up
  const highlightRects = Array.from(
    document.querySelectorAll('[data-hex-highlight]')
  ).map(getDocRect);
  const fillRects = Array.from(
    document.querySelectorAll('[data-hex-fill]')
  ).map(getDocRect);
  const edgeThreshold = size * 0.85; // how "thick" the outline band reads

  for (let r = -1; r <= rows; r++) {
    const y = r * vertStep;
    const offsetX = (r % 2 !== 0) ? hexWidth / 2 : 0;
    const cols = grid.count + 1;
    const t = Math.min(Math.max(y / docHeight, 0), 1);
    const scaleColor = lerpColor(colorTop, colorBottom, t);

    for (let c = -1; c <= cols; c++) {
      const x = c * hexWidth + offsetX;

      const isHighlightEdge = highlightRects.some(rect =>
        isHexOnRectEdge(x, y, edgeThreshold, rect)
      );
      const isFillEdge = fillRects.some(rect =>
        isHexOnRectEdge(x, y, edgeThreshold, rect)
      );
      const isFillInterior = fillRects.some(rect =>
        isPointInRect(x, y, rect)
      );

      const isActive = isHighlightEdge || isFillEdge || isFillInterior;

      if (isActive) {
        ctx.save();
        ctx.shadowColor = scaleColor;
        ctx.shadowBlur = 14;
        fillHex(ctx, x, y, size, scaleColor);
        ctx.restore();
      } else if (c === targetCol) {
        fillHex(ctx, x, y, size, scaleColor);
      }
      // else: hex is unused — skip drawing entirely, stays invisible
    }
  }

  // Cache everything hover needs so it never has to touch the
  // full grid loop or requery the DOM on mouse movement.
  gridState = {
    docHeight, size, hexWidth, vertStep, targetCol,
    colorTop, colorBottom, highlightRects, fillRects, edgeThreshold
  };

  // The base grid changed (resize/load) — refresh the hover hex too,
  // since its position/size are now stale otherwise.
  renderHover();

  statsEl.textContent =
    `viewport: ${viewportWidth}px  |  hexagons across: ${grid.count}  |  ` +
    `hex width: ${grid.hexWidth.toFixed(2)}px  |  hex size (circumradius): ${size.toFixed(2)}px`;
}

// ---------------------------------------------
// Cheap, per-frame hover redraw. Only touches the small
// hover canvas layered on top — never repaints the full grid.
// ---------------------------------------------
function renderHover() {
  hoverCtx.clearRect(0, 0, hoverCanvas.width, hoverCanvas.height);

  if (!gridState || mouse.x === null || mouse.y === null) return;

  const {
    docHeight, size, hexWidth, vertStep, targetCol,
    colorTop, colorBottom, highlightRects, fillRects, edgeThreshold
  } = gridState;

  let closest = null;

  // Reverse-map the cursor to an approximate (row, col), then
  // check a small neighborhood (3x3) since pointy-top offset rows
  // mean the true nearest center isn't always the naive guess.
  for (let dr = -1; dr <= 1; dr++) {
    const rGuess = Math.round(mouse.y / vertStep) + dr;
    const rowOffsetX = (rGuess % 2 !== 0) ? hexWidth / 2 : 0;

    for (let dc = -1; dc <= 1; dc++) {
      const cGuess = Math.round((mouse.x - rowOffsetX) / hexWidth) + dc;
      const cx = cGuess * hexWidth + rowOffsetX;
      const cy = rGuess * vertStep;
      const dist = Math.hypot(cx - mouse.x, cy - mouse.y);

      if (!closest || dist < closest.dist) {
        closest = { c: cGuess, cx, cy, dist };
      }
    }
  }

  // Only light up if the cursor is genuinely within this hex,
  // not just nearest to it from far away.
  if (!closest || closest.dist > size) return;

  const hoverT = Math.min(Math.max(closest.cy / docHeight, 0), 1);
  const hoverGradientColor = lerpColor(colorTop, colorBottom, hoverT);

  const wasEdge = highlightRects.some(rect =>
    isHexOnRectEdge(closest.cx, closest.cy, edgeThreshold, rect)
  ) || fillRects.some(rect =>
    isHexOnRectEdge(closest.cx, closest.cy, edgeThreshold, rect)
  );
  const wasFillInterior = fillRects.some(rect =>
    isPointInRect(closest.cx, closest.cy, rect)
  );
  const wasActive = wasEdge || wasFillInterior || closest.c === targetCol;

  const hoverColor = wasActive
    ? invertColor(hoverGradientColor)  // already colored -> invert
    : hoverGradientColor;              // background -> gradient at this point

  hoverCtx.save();
  hoverCtx.shadowColor = hoverColor;
  hoverCtx.shadowBlur = 16;
  fillHex(hoverCtx, closest.cx, closest.cy, size, hoverColor);
  hoverCtx.restore();
}

// ---------------------------------------------
// 4. Recalculate on resize (debounced) and on load
// ---------------------------------------------
let resizeTimeout;
window.addEventListener('resize', () => {
  clearTimeout(resizeTimeout);
  resizeTimeout = setTimeout(renderGrid, 150);
});

window.addEventListener('load', renderGrid);

// Recalculate once more shortly after load in case fonts/images
// shift the document height.
setTimeout(renderGrid, 300);

// ---------------------------------------------
// 5. Hover tracking — throttled to one redraw per
//    animation frame so fast mouse movement doesn't
//    trigger a flood of full-grid redraws.
// ---------------------------------------------
let hoverRafPending = false;
function scheduleHoverRender() {
  if (hoverRafPending) return;
  hoverRafPending = true;
  requestAnimationFrame(() => {
    hoverRafPending = false;
    renderHover();
  });
}

window.addEventListener('mousemove', (e) => {
  const scrollX = window.scrollX || window.pageXOffset;
  const scrollY = window.scrollY || window.pageYOffset;
  mouse.x = e.clientX + scrollX;
  mouse.y = e.clientY + scrollY;
  scheduleHoverRender();
});

window.addEventListener('mouseleave', () => {
  mouse.x = null;
  mouse.y = null;
  scheduleHoverRender();
});