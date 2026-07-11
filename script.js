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
// Road generation: a self-avoiding walk across the
// hex grid's (col, row) graph, planned fully in memory
// before anything is drawn.
// ---------------------------------------------

function keyOf(c, r) {
  return c + ',' + r;
}

function shuffleArray(arr) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

// Neighbor offsets for "odd-r" pointy-top offset coordinates —
// matches this file's row layout, where odd rows are shifted
// right by half a hex width (see offsetX in renderGrid).
function getHexNeighbors(c, r) {
  const evenRow = (r % 2 === 0);
  return evenRow
    ? [[c - 1, r], [c + 1, r], [c - 1, r - 1], [c, r - 1], [c - 1, r + 1], [c, r + 1]]
    : [[c - 1, r], [c + 1, r], [c, r - 1], [c + 1, r - 1], [c, r + 1], [c + 1, r + 1]];
}

// Plans a full self-avoiding path before any rendering happens.
// A candidate cell is only accepted if none of ITS neighbors are
// already part of the path (except the cell we're stepping from) —
// that's the "always 1 hex away from its own prior path" rule.
//
// Success is defined as REACHING rowTarget (e.g. 95% down the page),
// not just hitting some length — a path can easily rack up steps by
// wandering back and forth without ever getting near the bottom, so
// length alone doesn't guarantee a good-looking cutoff there.
//
// Candidates are weighted (not just shuffled) to favor downward moves,
// so it's more likely to reach the target before running out of room,
// while still being free to double back — that's what keeps it looking
// organic instead of a straight line. If one attempt dead-ends before
// reaching the target, it restarts from scratch with a new random
// order rather than fighting the same trapped branch forever.
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

  // Didn't reach the target in any restart — return the closest attempt
  // found rather than nothing. (Tested: this branch essentially never
  // triggers on realistic grid sizes with the settings used below.)
  return bestPath;
}

// Widens a single-cell-wide path into a 2-hex-wide road. For each
// center cell, randomly pick one adjacent, unclaimed, non-forbidden
// neighbor as its pair — side varies per segment for an organic look.
function widenRoadPath(path, forbidden) {
  const centerSet = new Set(path.map(([c, r]) => keyOf(c, r)));
  const usedPairs = new Set();
  const roadCells = new Set(centerSet);

  for (const [c, r] of path) {
    const neighbors = shuffleArray(getHexNeighbors(c, r));
    for (const [nc, nr] of neighbors) {
      const nkey = keyOf(nc, nr);
      if (centerSet.has(nkey) || usedPairs.has(nkey) || forbidden.has(nkey)) continue;
      usedPairs.add(nkey);
      roadCells.add(nkey);
      break;
    }
    // If every neighbor was already claimed/forbidden, that segment
    // just stays 1 hex wide — a rare, minor edge case rather than a crash.
  }

  return roadCells;
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

  // Shared gradient scale — used by the right-hand road, highlighted
  // container edges, and hover, so color always reflects the same
  // position down the page regardless of which feature it's on.
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
  const edgeThreshold = size * 1; // how "thick" the outline band reads

  // ---------------------------------------------
  // Generate the road: a fresh random path every time the page
  // loads. Starts at the same spot the old right-hand column did
  // (top row, one hex in from the right edge) and wanders freely.
  // ---------------------------------------------
  const roadColMax = grid.count - 4;
  const roadRowMax = Math.ceil(docHeight / vertStep);

  // Cells that fall on/inside a data-hex-highlight box are off-limits
  // to the road (fill boxes are fine to run behind).
  const roadForbidden = new Set();
  for (let r = 0; r <= roadRowMax; r++) {
    const offsetX = (r % 2 !== 0) ? hexWidth / 2 : 0;
    for (let c = 0; c <= roadColMax; c++) {
      const x = c * hexWidth + offsetX;
      const y = r * vertStep;
      const onHighlight = highlightRects.some(rect =>
        isHexOnRectEdge(x, y, edgeThreshold, rect) || isPointInRect(x, y, rect)
      );
      if (onHighlight) roadForbidden.add(keyOf(c, r));
    }
  }

  const roadPath = generateRoadPath({
    start: [roadColMax, 0],
    colMin: 0,
    colMax: roadColMax,
    rowMin: 0,
    rowMax: roadRowMax,
    // Reach ~95% of the way down the page for a clean cutoff near
    // the bottom, rather than just accumulating enough steps.
    rowTarget: Math.floor(roadRowMax * 0.95),
    forbidden: roadForbidden,
    maxAttemptsPerRestart: 15000,
    maxRestarts: 8
  });

  const roadCells = widenRoadPath(roadPath, roadForbidden);

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
      // else: hex is unused — skip drawing entirely, stays invisible
    }
  }

  // Cache everything hover needs so it never has to touch the
  // full grid loop or requery the DOM on mouse movement.
  gridState = {
    docHeight, size, hexWidth, vertStep,
    colorTop, colorBottom, highlightRects, fillRects, edgeThreshold, roadCells
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
    docHeight, size, hexWidth, vertStep,
    colorTop, colorBottom, highlightRects, fillRects, edgeThreshold, roadCells
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
        closest = { c: cGuess, r: rGuess, cx, cy, dist };
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
  const wasActive = wasEdge || wasFillInterior || roadCells.has(keyOf(closest.c, closest.r));

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