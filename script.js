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

// Pointy-top hexagon geometry helpers
// width  = sqrt(3) * size
// height = 2 * size
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

// Color interpolation for the gradient column.
// Reads two hex colors ("#rrggbb") and blends them
// by t (0 -> colorA, 1 -> colorB).
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

// Inverts an "rgb(r, g, b)" string — used when hovering a hex thats already part of the gradient/highlight/fill system.
function invertColor(rgbStr) {
  const [r, g, b] = rgbStr.match(/\d+/g).map(Number);
  return `rgb(${255 - r}, ${255 - g}, ${255 - b})`;
}

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

// True if a point sits fully inside a rect (used for data-hex-fill, where we want the whole interior colored in, not just the edge band).
function isPointInRect(px, py, rect) {
  return px >= rect.left && px <= rect.right && py >= rect.top && py <= rect.bottom;
}

// Road generation: a self-avoiding walk across the hex grid's (col, row) graph, planned fully in memory before anything is drawn.

function keyOf(c, r) {
  return c + ',' + r;
}

function keyToCell(key) {
  const [c, r] = key.split(',').map(Number);
  return [c, r];
}

function shuffleArray(arr) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

function getHexNeighbors(c, r) {
  const evenRow = (r % 2 === 0);
  return evenRow
    ? [[c - 1, r], [c + 1, r], [c - 1, r - 1], [c, r - 1], [c - 1, r + 1], [c, r + 1]]
    : [[c - 1, r], [c + 1, r], [c, r - 1], [c + 1, r - 1], [c, r + 1], [c + 1, r + 1]];
}

function generateRoadPath({ start, colMin, colMax, rowMin, rowMax, rowTarget, forbidden, maxAttemptsPerRestart, maxRestarts }) {
  let bestPath = [start];
  let bestReachRow = start[1];

  function inBounds(cell) {
    return cell[0] >= colMin && cell[0] <= colMax && cell[1] >= rowMin && cell[1] <= rowMax;
  }

  function weightedOrder(candidates, current) {
    return candidates
      .map(cand => {
        const rowDelta = cand[1] - current[1];
        const bias = rowDelta > 0 ? 0.5 : (rowDelta === 0 ? 0 : -0.5);
        return { cand, score: Math.random() + bias };
      })
      .sort((a, b) => b.score - a.score)
      .map(x => x.cand);
  }

  for (let restart = 0; restart < maxRestarts; restart++) {
    const path = [start];
    const visited = new Set([keyOf(start[0], start[1])]);
    let attempts = 0;
    let succeeded = false;

    function isValidCandidate(candidate, current) {
      const ckey = keyOf(candidate[0], candidate[1]);
      if (visited.has(ckey) || forbidden.has(ckey)) return false;
      const currentKey = keyOf(current[0], current[1]);
      for (const n of getHexNeighbors(candidate[0], candidate[1])) {
        const nkey = keyOf(n[0], n[1]);
        if (nkey === currentKey) continue;
        if (visited.has(nkey)) return false;
      }
      return true;
    }

    function backtrack() {
      attempts++;
      const currentRow = path[path.length - 1][1];

      if (currentRow > bestReachRow || (currentRow === bestReachRow && path.length > bestPath.length)) {
        bestReachRow = currentRow;
        bestPath = path.slice();
      }
      if (currentRow >= rowTarget) { succeeded = true; return true; }
      if (attempts > maxAttemptsPerRestart) return true; // give up this restart, try a fresh one

      const current = path[path.length - 1];
      const candidates = weightedOrder(getHexNeighbors(current[0], current[1]).filter(inBounds), current);

      for (const candidate of candidates) {
        if (!isValidCandidate(candidate, current)) continue;

        path.push(candidate);
        visited.add(keyOf(candidate[0], candidate[1]));

        if (backtrack()) return true;

        path.pop();
        visited.delete(keyOf(candidate[0], candidate[1]));
      }
      return false;
    }

    backtrack();
    if (succeeded) return path;
  }
  return bestPath;
}

function bidirectionalPath(start, target, colMin, colMax, rowMin, rowMax, forbidden) {
  const startKey = keyOf(start[0], start[1]);
  const targetKey = keyOf(target[0], target[1]);

  function inBounds(cell) {
    return cell[0] >= colMin && cell[0] <= colMax && cell[1] >= rowMin && cell[1] <= rowMax;
  }

  const cameFromStart = new Map([[startKey, null]]);
  const cameFromTarget = new Map([[targetKey, null]]);
  let frontierStart = [start];
  let frontierTarget = [target];
  let meetKey = null;

  const maxSteps = (colMax - colMin + 1) * (rowMax - rowMin + 1);

  for (let step = 0; step < maxSteps && !meetKey; step++) {
    const expandStart = frontierStart.length <= frontierTarget.length;
    const frontier = expandStart ? frontierStart : frontierTarget;
    const cameFrom = expandStart ? cameFromStart : cameFromTarget;
    const otherCameFrom = expandStart ? cameFromTarget : cameFromStart;

    const nextFrontier = [];
    for (const cell of frontier) {
      for (const n of shuffleArray(getHexNeighbors(cell[0], cell[1]))) {
        if (!inBounds(n)) continue;
        const nkey = keyOf(n[0], n[1]);
        if (forbidden.has(nkey) || cameFrom.has(nkey)) continue;
        cameFrom.set(nkey, cell);
        nextFrontier.push(n);
        if (otherCameFrom.has(nkey)) { meetKey = nkey; break; }
      }
      if (meetKey) break;
    }

    if (expandStart) frontierStart = nextFrontier; else frontierTarget = nextFrontier;
    if (nextFrontier.length === 0 && !meetKey) break; // both sides exhausted, unreachable
  }

  if (!meetKey) return null;

  // Walk parent pointers from the meeting point back to each root,
  // then splice the two halves together into one start->target path.
  function chainToRoot(cameFrom, fromKey) {
    const chain = [];
    let curKey = fromKey;
    while (curKey !== null) {
      chain.push(keyToCell(curKey));
      const parent = cameFrom.get(curKey);
      curKey = parent ? keyOf(parent[0], parent[1]) : null;
    }
    return chain;
  }

  const startHalf = chainToRoot(cameFromStart, meetKey).reverse(); // start ... meet
  const targetHalf = chainToRoot(cameFromTarget, meetKey);          // meet ... target
  return startHalf.concat(targetHalf.slice(1));
}

function freeStrandWalk({ start, colMin, colMax, rowMin, rowMax, forbidden, maxSteps }) {
  const path = [start];
  const visited = new Set([keyOf(start[0], start[1])]);
  let current = start;

  for (let step = 0; step < maxSteps; step++) {
    const candidates = getHexNeighbors(current[0], current[1])
      .filter(([c, r]) => c >= colMin && c <= colMax && r >= rowMin && r <= rowMax)
      .filter(([c, r]) => !forbidden.has(keyOf(c, r)) && !visited.has(keyOf(c, r)))
      .map(cand => {
        const rowDelta = cand[1] - current[1];
        const bias = rowDelta > 0 ? 0.5 : (rowDelta === 0 ? 0 : -0.5);
        return { cand, score: Math.random() + bias };
      })
      .sort((a, b) => b.score - a.score);

    if (candidates.length === 0) break; // dead end — the strand just ends here

    current = candidates[0].cand;
    path.push(current);
    visited.add(keyOf(current[0], current[1]));
  }

  return path;
}

// Produces one width value per skeleton cell
function organicWidths(pathLength, startWidth, maxWidth) {
  const widths = [];
  let w = startWidth;
  for (let i = 0; i < pathLength; i++) {
    widths.push(Math.max(1, Math.round(w)));
    const roll = Math.random();
    const delta = roll < 0.3 ? -1 : (roll > 0.7 ? 1 : 0);
    w = Math.min(maxWidth, Math.max(1, w + delta));
  }
  return widths;
}

// How far down its available room a strand actually runs before ending
function strandLifeFraction() {
  return 0.35 + 0.65 * Math.sqrt(Math.random());
}

function taperToEnd(widths) {
  const tailStart = Math.floor(widths.length * 0.85);
  return widths.map((w, i) => {
    if (i < tailStart) return w;
    const t = (i - tailStart) / Math.max(1, widths.length - tailStart);
    return Math.max(1, Math.round(w * (1 - t)));
  });
}

// Widens a skeleton path into a variable-width band by claiming up to (width - 1) extra unclaimed, non-forbidden neighbor hexes per cell.
function widenVariable(path, widths, forbidden, claimed) {
  path.forEach(([c, r], i) => {
    const key = keyOf(c, r);
    if (forbidden.has(key)) return;
    claimed.add(key);

    const extra = Math.max(0, (widths[i] ?? 1) - 1);
    if (extra === 0) return;

    let added = 0;
    for (const [nc, nr] of shuffleArray(getHexNeighbors(c, r))) {
      if (added >= extra) break;
      const nkey = keyOf(nc, nr);
      if (claimed.has(nkey) || forbidden.has(nkey)) continue;
      claimed.add(nkey);
      added++;
    }
  });
}

// Build + render the full-page tessellation
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

  const colorTop = '#1b4332';
  const colorBottom = '#EF9F27';

  // Two flavors of tagged element:
  // - data-hex-highlight: only the edge band lights up (pure outline)
  // - data-hex-fill:      edge band AND the full interior light up
  const highlightRects = Array.from(
    document.querySelectorAll('[data-hex-highlight]')
  ).map(getDocRect);
  const fillRects = Array.from(
    document.querySelectorAll('[data-hex-fill]')
  ).map(getDocRect);
  const edgeThreshold = size * 1; // how "thick" the outline band reads

  const roadColMax = grid.count;
  const roadRowMax = Math.ceil(docHeight / vertStep);
  const roadForbidden = new Set();
  const claimed = new Set();
  const numStrands = 5;
  const segmentWidth = (roadColMax + 1) / numStrands;
  const splitCols = Array.from({ length: numStrands }, (_, i) => {
    const segStart = Math.floor(i * segmentWidth);
    const segEnd = Math.min(roadColMax, Math.floor((i + 1) * segmentWidth) - 1);
    return segStart + Math.floor(Math.random() * Math.max(1, segEnd - segStart + 1));
  });

  const funnelRows = 6;
  const funnelMouthHalfWidth = Math.ceil(segmentWidth / 2) + 1;
  const funnelBaseHalfWidth = 1;

  for (let r = 0; r <= funnelRows; r++) {
    const t = r / funnelRows;
    const halfWidth = Math.round(
      funnelMouthHalfWidth + (funnelBaseHalfWidth - funnelMouthHalfWidth) * t
    );
    for (const splitCol of splitCols) {
      for (let dc = -halfWidth; dc <= halfWidth; dc++) {
        const c = splitCol + dc;
        if (c < 0 || c > roadColMax) continue;
        claimed.add(keyOf(c, r));
      }
    }
  }

  const splitRow = funnelRows;
  const splitOrigins = splitCols.map(c => [c, splitRow]);

  for (const origin of splitOrigins) {
    const skeleton = freeStrandWalk({
      start: origin, colMin: 0, colMax: roadColMax,
      rowMin: 0, rowMax: roadRowMax, forbidden: roadForbidden,
      maxSteps: roadRowMax
    });
    const lifeLength = Math.max(3, Math.round(skeleton.length * strandLifeFraction()));
    const trimmedSkeleton = skeleton.slice(0, lifeLength);
    const widths = taperToEnd(organicWidths(trimmedSkeleton.length, 2, 3));
    widenVariable(trimmedSkeleton, widths, roadForbidden, claimed);
  }

  const roadCells = claimed;

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
      const isRoadHex = roadCells.has(keyOf(c, r));

      const isActive = isHighlightEdge || isFillEdge || isFillInterior || isRoadHex;

      if (isActive) {
        ctx.save();
        ctx.shadowColor = scaleColor;
        ctx.shadowBlur = 14;
        fillHex(ctx, x, y, size, scaleColor);
        ctx.restore();
      }
    }
  }

  gridState = {
    docHeight, size, hexWidth, vertStep,
    colorTop, colorBottom, highlightRects, fillRects, edgeThreshold, roadCells
  };
  renderHover();

  statsEl.textContent =
    `viewport: ${viewportWidth}px  |  hexagons across: ${grid.count}  |  ` +
    `hex width: ${grid.hexWidth.toFixed(2)}px  |  hex size (circumradius): ${size.toFixed(2)}px`;
}

// Cheap, per-frame hover redraw. Only touches the small
// hover canvas layered on top — never repaints the full grid.
function renderHover() {
  hoverCtx.clearRect(0, 0, hoverCanvas.width, hoverCanvas.height);

  if (!gridState || mouse.x === null || mouse.y === null) return;

  const {
    docHeight, size, hexWidth, vertStep,
    colorTop, colorBottom, highlightRects, fillRects, edgeThreshold, roadCells
  } = gridState;

  let closest = null;

  for (let dr = -1; dr <= 1; dr++) {
    const rGuess = Math.round(mouse.y / vertStep) + dr;
    const rowOffsetX = (rGuess % 2 !== 0) ? hexWidth / 2 : 0;

    for (let dc = -1; dc <= 1; dc++) {
      const cGuess = Math.round((mouse.x - rowOffsetX) / hexWidth) + dc;
      const cx = cGuess * hexWidth + rowOffsetX;
      const cy = rGuess * vertStep;
      const dist = Math.hypot(cx - mouse.x, cy - mouse.y);

      if (!closest || dist < closest.dist) {
        closest = { c: cGuess, r: rGuess, cx, cy, dist };
      }
    }
  }

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
  const wasActive = wasEdge || wasFillInterior || roadCells.has(keyOf(closest.c, closest.r));

  const hoverColor = wasActive
    ? invertColor(hoverGradientColor)
    : hoverGradientColor; 

  hoverCtx.save();
  hoverCtx.shadowColor = hoverColor;
  hoverCtx.shadowBlur = 16;
  fillHex(hoverCtx, closest.cx, closest.cy, size, hoverColor);
  hoverCtx.restore();
}

let resizeTimeout;
window.addEventListener('resize', () => {
  clearTimeout(resizeTimeout);
  resizeTimeout = setTimeout(renderGrid, 150);
});

window.addEventListener('load', renderGrid);

setTimeout(renderGrid, 300);

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