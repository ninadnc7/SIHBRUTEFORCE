import React, { useEffect, useRef, useState } from "react";

// Traffic Signal Simulator
// - 5 intersections laid out like the 5 dots on a dice (four corners + center)
// - Roads connect intersections orthogonally (no diagonal connections)
// - Each road has 3 lanes (visual only)
// - Signals support Left / Straight / Right phases
// - Cars (small circles) travel along roads; as each car crosses an intersection
//   a random name (string) is generated and recorded in an in-memory list
// - The app can export the recorded crossings to an Excel file (xlsx)

// NOTE: To run in a local React project:
// 1. Create a React app (e.g. using `create-react-app`).
// 2. Save this file and import it in App.jsx: `import TrafficSim from './traffic-signal-simulator'` and render <TrafficSim />.
// 3. Install sheetjs: `npm install xlsx` (the code imports `xlsx` for Excel export).

import * as XLSX from "xlsx";

// layout of the five intersections (die-5 pattern)
const INTERSECTIONS = [
  { id: 1, x: 100, y: 100 }, // top-left
  { id: 2, x: 300, y: 100 }, // top-right
  { id: 3, x: 200, y: 200 }, // center
  { id: 4, x: 100, y: 300 }, // bottom-left
  { id: 5, x: 300, y: 300 }, // bottom-right
];

// orthogonal connections (by id). no diagonals.
const LINKS = [
  [1, 2],
  [1, 3],
  [2, 3],
  [3, 4],
  [3, 5],
  [4, 5],
];

const ROAD_WIDTH = 40; // visual width for 3 lanes
const LANE_COUNT = 3;

// helpers
const randString = (len = 6) => {
  const chars = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
  let s = "";
  for (let i = 0; i < len; i++) s += chars[Math.floor(Math.random() * chars.length)];
  return s;
};

function distance(a, b) {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

// A simple path-finding between intersections using adjacency (shortest path by hops)
function findPath(startId, endId) {
  if (startId === endId) return [startId];
  const adj = {};
  INTERSECTIONS.forEach((n) => (adj[n.id] = []));
  LINKS.forEach(([a, b]) => {
    adj[a].push(b);
    adj[b].push(a);
  });
  const q = [[startId]];
  const seen = new Set([startId]);
  while (q.length) {
    const path = q.shift();
    const last = path[path.length - 1];
    for (const nb of adj[last]) {
      if (seen.has(nb)) continue;
      const newPath = [...path, nb];
      if (nb === endId) return newPath;
      q.push(newPath);
      seen.add(nb);
    }
  }
  return null; // no path
}

// Car object: has a path of intersection ids to travel through and a progress along current segment
function createCar(startId, destId) {
  const path = findPath(startId, destId);
  if (!path) return null;
  return {
    id: Math.random().toString(36).slice(2, 9),
    name: randString(8),
    path,
    segmentIndex: 0, // traveling from path[i] to path[i+1]
    t: 0, // 0..1 progress along segment
    speed: 0.002 + Math.random() * 0.003, // adjustable
    color: "#" + Math.floor(Math.random() * 0xffffff).toString(16).padStart(6, "0"),
    intendedTurn: null, // 'left'|'right'|'straight' set when approaching intersection
    stopped: false,
  };
}

export default function TrafficSim() {
  const [cars, setCars] = useState([]);
  const [running, setRunning] = useState(true);
  const [records, setRecords] = useState([]); // {name, intersectionId, timestamp}
  const rafRef = useRef(null);

  // traffic signals state per intersection
  // each intersection has a phase object which states which incoming directions are allowed for which movement
  // for simplicity we'll implement a rotating phase: North-South straight+right, East-West straight+right, then left turns etc.
  const [signals, setSignals] = useState(() => {
    const s = {};
    INTERSECTIONS.forEach((i) => {
      s[i.id] = { phase: 0, timer: 0 };
    });
    return s;
  });

  useEffect(() => {
    // spawn cars periodically
    const spawn = setInterval(() => {
      // pick random start and destination among intersections
      let a = INTERSECTIONS[Math.floor(Math.random() * INTERSECTIONS.length)].id;
      let b = INTERSECTIONS[Math.floor(Math.random() * INTERSECTIONS.length)].id;
      if (a === b) {
        b = INTERSECTIONS[Math.floor(Math.random() * INTERSECTIONS.length)].id;
        if (a === b) return; // rare
      }
      const car = createCar(a, b);
      if (car) setCars((c) => [...c, car]);
    }, 1200);
    return () => clearInterval(spawn);
  }, []);

  useEffect(() => {
    // animate
    let last = performance.now();
    function step(now) {
      const dt = now - last;
      last = now;
      // update signals timers
      setSignals((prev) => {
        const next = { ...prev };
        Object.keys(next).forEach((id) => {
          const copy = { ...next[id] };
          copy.timer += dt;
          // phase durations in ms
          const PHASES = [4000, 3000, 2000];
          if (copy.timer >= PHASES[copy.phase] || copy.phase >= PHASES.length) {
            copy.timer = 0;
            copy.phase = (copy.phase + 1) % PHASES.length;
          }
          next[id] = copy;
        });
        return next;
      });

      if (running) {
        setCars((prev) => {
          const updated = prev
            .map((car) => {
              // if car has finished path, drop it
              if (car.segmentIndex >= car.path.length - 1) return null;
              const fromId = car.path[car.segmentIndex];
              const toId = car.path[car.segmentIndex + 1];
              const from = INTERSECTIONS.find((n) => n.id === fromId);
              const to = INTERSECTIONS.find((n) => n.id === toId);
              const segLen = distance(from, to);

              // check intersection at 'to' if car is about to enter
              // consider stop when car.t close to 1 (approaching intersection)

              let willEnter = car.t + car.speed * (dt / 16) >= 1 - 0.02; // approaching

              if (willEnter) {
                // decide intended turn based on next hop (if exists)
                let movement = "straight";
                const prevNode = from;
                const nextNode = to;
                const nextNextId = car.path[car.segmentIndex + 2];
                if (nextNextId) {
                  const nextNextNode = INTERSECTIONS.find((n) => n.id === nextNextId);
                  // compute turn type relative to direction from prev->next and next->nextNext
                  const dir1 = { x: next.x - from.x, y: next.y - from.y };
                  const dir2 = { x: nextNextNode.x - next.x, y: nextNextNode.y - next.y };
                  // cross product z to determine left/right
                  const cross = dir1.x * dir2.y - dir1.y * dir2.x;
                  if (cross > 0) movement = "left";
                  else if (cross < 0) movement = "right";
                  else movement = "straight";
                }

                // check signal at 'to' to see if this movement is allowed
                const signal = signals[toId];
                // simplify phase mapping: phase 0 allows vertical straight+right (N-S), phase1 allows horizontal straight+right (E-W), phase2 allows left turns all
                const fromVector = { x: next.x - from.x, y: next.y - from.y };
                const isVertical = Math.abs(fromVector.x) < Math.abs(fromVector.y);
                let allowed = false;
                if (signal) {
                  if (signal.phase === 2) {
                    allowed = movement === "left";
                  } else if (signal.phase === 0) {
                    // vertical allowed
                    if (isVertical && movement !== "left") allowed = true;
                  } else if (signal.phase === 1) {
                    if (!isVertical && movement !== "left") allowed = true;
                  }
                }

                if (!allowed) {
                  // stop at 0.98
                  car.t = Math.min(car.t, 0.98);
                  car.stopped = true;
                  return car;
                } else {
                  if (car.stopped) car.stopped = false;
                  // allow to pass; when pass center, record crossing
                  // we record when t > 0.5 (in middle of segment)
                }
              }

              // progress
              if (!car.stopped) {
                car.t += car.speed * (dt / 16);
              }

              if (car.t >= 1) {
                // moved to next segment
                car.segmentIndex += 1;
                car.t = 0;
                // record crossing at the node we just arrived to (toId)
                const crossing = {
                  name: car.name,
                  intersectionId: toId,
                  time: new Date().toISOString(),
                };
                setRecords((r) => [...r, crossing]);
              }

              return car;
            })
            .filter(Boolean);
          return updated;
        });
      }

      rafRef.current = requestAnimationFrame(step);
    }

    rafRef.current = requestAnimationFrame(step);
    return () => cancelAnimationFrame(rafRef.current);
  }, [running, signals]);

  function getPositionOnSegment(from, to, t) {
    return { x: from.x + (to.x - from.x) * t, y: from.y + (to.y - from.y) * t };
  }

  function exportExcel() {
    // convert records to worksheet
    const ws = XLSX.utils.json_to_sheet(records);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, "crossings");
    XLSX.writeFile(wb, "crossings.xlsx");
  }

  function clearRecords() {
    setRecords([]);
  }

  function toggleRunning() {
    setRunning((r) => !r);
  }

  return (
    <div className="p-4 font-sans">
      <div className="flex items-center gap-4 mb-4">
        <button className="px-4 py-2 rounded bg-slate-700 text-white" onClick={toggleRunning}>
          {running ? "Pause" : "Resume"}
        </button>
        <button className="px-4 py-2 rounded bg-slate-700 text-white" onClick={exportExcel}>
          Export crossings to Excel
        </button>
        <button className="px-4 py-2 rounded bg-red-600 text-white" onClick={clearRecords}>
          Clear records
        </button>
        <div className="ml-4">
          <strong>Total cars:</strong> {cars.length}
        </div>
        <div className="ml-4">
          <strong>Records:</strong> {records.length}
        </div>
      </div>

      <div className="bg-white rounded p-4 shadow">
        <svg width={420} height={420} viewBox={`0 0 420 420`}>
          {/* draw roads */}
          {LINKS.map(([a, b], idx) => {
            const A = INTERSECTIONS.find((n) => n.id === a);
            const B = INTERSECTIONS.find((n) => n.id === b);
            const dx = B.x - A.x;
            const dy = B.y - A.y;
            const angle = Math.atan2(dy, dx);
            // center line
            return (
              <g key={idx} transform={`translate(0,0)`}> 
                {/* draw 3 lanes as parallel lines */}
                {[...Array(LANE_COUNT)].map((_, laneIdx) => {
                  const offset = (-ROAD_WIDTH / 2) + (laneIdx + 0.5) * (ROAD_WIDTH / LANE_COUNT);
                  // perpendicular offset
                  const ox = -Math.sin(angle) * offset;
                  const oy = Math.cos(angle) * offset;
                  return (
                    <line
                      key={laneIdx}
                      x1={A.x + ox}
                      y1={A.y + oy}
                      x2={B.x + ox}
                      y2={B.y + oy}
                      stroke="#e6e6e6"
                      strokeWidth={8}
                      strokeLinecap="round"
                    />
                  );
                })}
              </g>
            );
          })}

          {/* intersections */}
          {INTERSECTIONS.map((node) => {
            const sig = signals[node.id] || { phase: 0, timer: 0 };
            return (
              <g key={node.id} transform={`translate(${node.x}, ${node.y})`}>
                <rect x={-24} y={-24} width={48} height={48} rx={6} fill="#f8fafc" stroke="#94a3b8" />
                <text x={0} y={5} fontSize={12} textAnchor="middle" fill="#0f172a">
                  {node.id}
                </text>
                {/* simple traffic light indicator */}
                <g transform={`translate(26, -18)`}>{/* small 3-circle light */}
                  <circle cx={0} cy={0} r={4} fill={sig.phase === 0 ? "green" : "#e2e8f0"} />
                  <circle cx={0} cy={12} r={4} fill={sig.phase === 1 ? "green" : "#e2e8f0"} />
                  <circle cx={0} cy={24} r={4} fill={sig.phase === 2 ? "green" : "#e2e8f0"} />
                </g>
              </g>
            );
          })}

          {/* cars */}
          {cars.map((car) => {
            const fromId = car.path[car.segmentIndex];
            const toId = car.path[Math.min(car.segmentIndex + 1, car.path.length - 1)];
            const from = INTERSECTIONS.find((n) => n.id === fromId);
            const to = INTERSECTIONS.find((n) => n.id === toId);
            const pos = getPositionOnSegment(from, to, car.t);
            return (
              <g key={car.id} transform={`translate(${pos.x}, ${pos.y})`}>
                <circle r={6} fill={car.color} stroke="#000" strokeWidth={0.5} />
              </g>
            );
          })}
        </svg>
      </div>

      <div className="mt-4">
        <h3 className="font-semibold">Recent crossings (latest 10):</h3>
        <div className="max-h-48 overflow-auto border rounded mt-2 p-2 bg-white">
          {records
            .slice()
            .reverse()
            .slice(0, 10)
            .map((r, idx) => (
              <div key={idx} className="text-sm py-1 border-b last:border-b-0">
                <strong>{r.name}</strong> crossed intersection <strong>{r.intersectionId}</strong> at {new Date(r.time).toLocaleTimeString()}
              </div>
            ))}
        </div>
      </div>

      <div className="mt-4 text-xs text-slate-600">
        <p>This is a simplified simulation: lane-level reservation, collision avoidance and realistic turning models are not implemented. The signal phases are simplified (phase 0: vertical straight+right, phase 1: horizontal straight+right, phase 2: left turns).</p>
      </div>
    </div>
  );
}
