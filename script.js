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

  for (let r = -1; r <= rows; r++) {
    const y = r * vertStep;
    const offsetX = (r % 2 !== 0) ? hexWidth / 2 : 0;
    const cols = grid.count + 1;

    for (let c = -1; c <= cols; c++) {
      const x = c * hexWidth + offsetX;
      drawHex(ctx, x, y, size);
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