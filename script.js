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

// Fills a hex path instead of stroking it (used for the gradient column)
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
  ctx.stroke(); // keep the outline consistent with the rest of the grid
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

// ---------------------------------------------
// 3. Build + render the full-page tessellation
// ---------------------------------------------
const canvas = document.getElementById('hexCanvas');
const ctx = canvas.getContext('2d');
const statsEl = document.getElementById('stats');

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

  ctx.clearRect(0, 0, canvas.width, canvas.height);
  ctx.strokeStyle = 'rgba(234, 231, 221, 0.12)';
  ctx.lineWidth = 1;

  const rows = Math.ceil(docHeight / vertStep) + 2;

  // The last "real" column before the right-hand edge.
  // Columns run 0 .. grid.count-1 across the exact viewport width,
  // so grid.count - 1 is one hex in from the edge.
  const targetCol = grid.count - 1;

  // Gradient endpoints — swap these for whatever palette you want.
  const colorTop = '#1b4332';    // deep forest green
  const colorBottom = '#ffb703'; // amber

  // Any element tagged data-hex-highlight gets its edges
  // traced by the hex grid.
  const highlightRects = Array.from(
    document.querySelectorAll('[data-hex-highlight]')
  ).map(getDocRect);
  const edgeThreshold = size * 0.85; // how "thick" the outline band reads

  for (let r = -1; r <= rows; r++) {
    const y = r * vertStep;
    const offsetX = (r % 2 !== 0) ? hexWidth / 2 : 0;
    const cols = grid.count + 1;

    for (let c = -1; c <= cols; c++) {
      const x = c * hexWidth + offsetX;

      const isEdgeHex = highlightRects.some(rect =>
        isHexOnRectEdge(x, y, edgeThreshold, rect)
      );

      if (isEdgeHex) {
        ctx.save();
        ctx.shadowColor = 'rgba(255, 183, 3, 0.9)';
        ctx.shadowBlur = 12;
        fillHex(ctx, x, y, size, 'rgba(255, 183, 3, 0.85)');
        ctx.restore();
      } else if (c === targetCol) {
        const t = Math.min(Math.max(y / docHeight, 0), 1);
        fillHex(ctx, x, y, size, lerpColor(colorTop, colorBottom, t));
      } else {
        drawHex(ctx, x, y, size);
      }
    }
  }

  statsEl.textContent =
    `viewport: ${viewportWidth}px  |  hexagons across: ${grid.count}  |  ` +
    `hex width: ${grid.hexWidth.toFixed(2)}px  |  hex size (circumradius): ${size.toFixed(2)}px`;
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