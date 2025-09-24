// src/traffic-signal-simulator.jsx
// Cleaned 3x3 grid-only traffic simulator with robust signals (no flicker), vehicles spawn at two corners only,
// queue properly, stop at amber & red, and won't collide in intersections.
//
// Optional: npm install xlsx to enable Export button.

import React, { useEffect, useRef, useState } from "react";

let XLSX = null;
try { XLSX = require("xlsx"); } catch (e) { /* optional */ }

/* ---------------- Helpers ---------------- */
const clamp = (n, a, b) => Math.max(a, Math.min(b, n));
const randName = (len = 6) => {
  const s = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let r = "";
  for (let i = 0; i < len; i++) r += s[Math.floor(Math.random() * s.length)];
  return r;
};
const nowMs = () => Date.now();

/* ---------------- Config ---------------- */
const DEFAULT_GREEN = 3200;
const DEFAULT_AMBER = 700;
const MIN_PHASE = 600;
const NODE_STEP = 20;
const STOP_LINE = 22;
const VEHICLE_GAP = 18; // pixels gap in queue
const MAX_RECORDS_KEEP = 4000;

/* vehicle specs */
const VEHICLE_TYPES = {
  car: { length: 16, width: 8, color: "#2b6ef6" },
  taxi: { length: 16, width: 8, color: "#f59e0b" },
  bus: { length: 22, width: 10, color: "#10b981" },
  ambulance: { length: 18, width: 9, color: "#ef4444" },
  truck: { length: 20, width: 9, color: "#6b7280" },
};

/* ---------------- Component ---------------- */
export default function TrafficSignalSimulator() {
  /* UI & control state */
  const [simSpeed, setSimSpeed] = useState(1);
  const [running, setRunning] = useState(true);
  const [spawnInterval, setSpawnInterval] = useState(1200);
  const [maxVehicles, setMaxVehicles] = useState(60);
  const [spawnWeights, setSpawnWeights] = useState({ car: 0.8, taxi: 0.12, bus: 0.03, ambulance: 0.02, truck: 0.03 });
  const [adaptive, setAdaptive] = useState(true);
  const [useWebster, setUseWebster] = useState(true);
  const [priorityEnabled, setPriorityEnabled] = useState(true);
  const [priorityDuration, setPriorityDuration] = useState(3500);

  /* world state */
  const [INTERSECTIONS, setINTERSECTIONS] = useState([]);
  const [LINKS, setLINKS] = useState([]);
  const [NODE_MAP, setNODE_MAP] = useState({});
  const [GRAPH, setGRAPH] = useState({});
  const [SPAWN_NODES, setSPAWN_NODES] = useState([]); // spawn nodes (two corners only)
  const [signals, setSignals] = useState({});
  const signalsRef = useRef(signals);
  useEffect(()=>{ signalsRef.current = signals; }, [signals]);

  const [vehicles, setVehicles] = useState([]);
  const vehiclesRef = useRef(vehicles);
  useEffect(()=>{ vehiclesRef.current = vehicles; }, [vehicles]);

  const [records, setRecords] = useState([]);
  const arrivalRef = useRef({});
  const occupancyRef = useRef({});
  const vehicleIdCounter = useRef(1);
  const rafRef = useRef(null);
  const lastNowRef = useRef(performance.now());
  const [selectedIntersection, setSelectedIntersection] = useState(null);

  /* Build a fixed 3x3 grid (always) */
  useEffect(()=>{
    const GRID_SIZE = 3;
    const SPACING = 160;
    const ORIGIN = { x: 80, y: 80 };
    const ints = [];
    let idCounter = 1;
    for (let r=0;r<GRID_SIZE;r++){
      for (let c=0;c<GRID_SIZE;c++){
        ints.push({ id: idCounter++, x: ORIGIN.x + c*SPACING, y: ORIGIN.y + r*SPACING, r, c });
      }
    }
    const links = [];
    for (let r=0;r<GRID_SIZE;r++){
      for (let c=0;c<GRID_SIZE;c++){
        const idx = r*GRID_SIZE + c;
        if (c < GRID_SIZE-1) links.push([ints[idx].id, ints[idx+1].id]);
        if (r < GRID_SIZE-1) links.push([ints[idx].id, ints[idx+GRID_SIZE].id]);
      }
    }

    // waypoints & nodeMap
    let wpId = 1000;
    const nodeMap = {};
    ints.forEach(n => nodeMap[n.id] = { x:n.x, y:n.y, isIntersection:true, id:n.id });
    const WAYPOINTS = {};
    links.forEach(([a,b])=>{
      const A = ints.find(i=>i.id===a), B = ints.find(i=>i.id===b);
      const dx = B.x - A.x, dy = B.y - A.y;
      const d = Math.hypot(dx,dy);
      const steps = Math.max(2, Math.floor(d / NODE_STEP));
      const arr = [];
      for (let i=1;i<steps;i++){
        const t = i/steps;
        const x = A.x + dx*t, y = A.y + dy*t;
        const id = wpId++;
        arr.push({ id, x, y });
        nodeMap[id] = { x,y, isIntersection:false, id };
      }
      WAYPOINTS[`${a}-${b}`] = arr;
      WAYPOINTS[`${b}-${a}`] = arr.slice().reverse().map(w => ({ id: w.id, x: w.x, y: w.y }));
    });

    // adjacency graph
    const Gset = {};
    Object.keys(nodeMap).forEach(k => Gset[k] = new Set());
    links.forEach(([a,b])=>{
      const way = WAYPOINTS[`${a}-${b}`] || [];
      if (way.length === 0) {
        Gset[String(a)].add(String(b));
        Gset[String(b)].add(String(a));
      } else {
        Gset[String(a)].add(String(way[0].id));
        for (let i=0;i<way.length-1;i++){
          Gset[String(way[i].id)].add(String(way[i+1].id));
          Gset[String(way[i+1].id)].add(String(way[i].id));
        }
        Gset[String(way[way.length-1].id)].add(String(b));
        const rev = WAYPOINTS[`${b}-${a}`] || [];
        if (rev.length>0) Gset[String(b)].add(String(rev[0].id)); else Gset[String(b)].add(String(a));
      }
    });
    const G = {}; Object.keys(Gset).forEach(k => G[k] = Array.from(Gset[k]));

    // spawn nodes: two corners only: top-left (row0,col0) and bottom-right (row2,col2)
    const topLeft = ints.find(p => p.r===0 && p.c===0).id;
    const bottomRight = ints.find(p => p.r===2 && p.c===2).id;
    const spawnNodes = [topLeft, bottomRight];

    // signals: one per intersection, approaches set
    const s = {};
    ints.forEach(n=>{
      const approaches = {};
      links.forEach(([a,b]) => {
        if (a===n.id) approaches[b] = { lamp:"red", allowed:[false,false,false] };
        if (b===n.id) approaches[a] = { lamp:"red", allowed:[false,false,false] };
      });
      // phases: 0 = vertical (N-S straight+right), 1 = horizontal (E-W straight+right), 2 = left-protected (all lefts)
      s[n.id] = { phase:0, timer:0, durations:[DEFAULT_GREEN, DEFAULT_GREEN, 1200], manual:false, manualPhase:0, manualDur:DEFAULT_GREEN, approaches, stats:{passed:0,left:0,straight:0,right:0}, recent:[], changeLog:"initialized" };
    });

    setINTERSECTIONS(ints);
    setLINKS(links);
    setNODE_MAP(nodeMap);
    setGRAPH(G);
    setSPAWN_NODES(spawnNodes);
    setSignals(s);
    signalsRef.current = s;
    setVehicles([]);
    vehiclesRef.current = [];
    arrivalRef.current = {};
    occupancyRef.current = {};
    vehicleIdCounter.current = 1;
    setRecords([]);
  }, []);

  /* BFS pathfinder */
  function findPath(startId, endId) {
    const s = String(startId), e = String(endId);
    if (!GRAPH || !GRAPH[s]) return null;
    const q = [[s]];
    const seen = new Set([s]);
    while (q.length) {
      const path = q.shift();
      const last = path[path.length-1];
      if (last === e) return path.map(x=>Number(x));
      const neighbors = GRAPH[last] || [];
      for (const nb of neighbors) {
        if (!seen.has(nb)) { seen.add(nb); q.push([...path, nb]); }
      }
    }
    return null;
  }

  /* create vehicle spawning only from SPAWN_NODES to the opposite spawn (two corners only) */
  function createVehicleCorner() {
    if (!SPAWN_NODES || SPAWN_NODES.length < 2) return null;
    const a = SPAWN_NODES[0];
    const b = SPAWN_NODES[1];
    // randomly pick source as a or b
    const src = Math.random() < 0.5 ? a : b;
    const dest = src === a ? b : a;
    // choose type by spawnWeights
    let sum = 0; Object.values(spawnWeights).forEach(v=>sum+=v); if (sum <= 0) { spawnWeights.car = 1; sum = 1; }
    const r = Math.random(); let acc = 0; let chosen = "car";
    for (const k of Object.keys(spawnWeights)) { acc += spawnWeights[k]/sum; if (r <= acc) { chosen = k; break; } }
    const pathNodes = findPath(src, dest);
    if (!pathNodes || pathNodes.length < 2) return null;
    return {
      id: `v-${vehicleIdCounter.current++}`,
      name: randName(),
      type: chosen,
      spec: VEHICLE_TYPES[chosen] || VEHICLE_TYPES.car,
      nodePath: pathNodes,
      nodeIndex: 0,
      t: 0,
      speed: 0.0012 + Math.random()*0.0020,
      laneIndex: 1,
      stopped: false,
      queuedSince: null,
      finishedAt: null
    };
  }

  /* spawn loop (corners only) */
  useEffect(()=>{
    const interval = Math.max(80, Math.round(spawnInterval / simSpeed));
    const id = setInterval(()=>{
      setVehicles(prev => {
        if (!SPAWN_NODES || SPAWN_NODES.length < 2) return prev;
        if (prev.length >= maxVehicles) return prev;
        const v = createVehicleCorner();
        if (v) return [...prev, v];
        return prev;
      });
    }, interval);
    return () => clearInterval(id);
  }, [SPAWN_NODES, spawnInterval, maxVehicles, simSpeed, spawnWeights]);

  /* compute queues used by timing */
  function computeQueues(allVehicles) {
    const q = {};
    INTERSECTIONS.forEach(n => {
      q[n.id] = { totals:{v:0,h:0,l:0}, byApproach:{} };
      const entInit = {};
      LINKS.forEach(([a,b]) => { if (a===n.id) entInit[b] = [0,0,0]; if (b===n.id) entInit[a] = [0,0,0]; });
      Object.keys(entInit).forEach(k => q[n.id].byApproach[k] = [0,0,0]);
    });
    allVehicles.forEach(v=>{
      const idx = v.nodeIndex, path = v.nodePath;
      if (!path) return;
      if (idx >= path.length - 1) return;
      const from = path[idx], to = path[idx+1];
      // only count if vehicle is near stop or stopped
      if (!(v.stopped || v.t > 0.72)) return;
      const nextNode = path[idx+2];
      let movement = "straight";
      if (nextNode) {
        const A = NODE_MAP[from], B = NODE_MAP[to], C = NODE_MAP[nextNode];
        if (A && B && C) {
          const d1 = { x: B.x - A.x, y: B.y - A.y }, d2 = { x: C.x - B.x, y: C.y - B.y };
          const cross = d1.x * d2.y - d1.y * d2.x;
          if (cross > 0) movement = "left";
          else if (cross < 0) movement = "right";
        }
      }
      const lane = movement === "left" ? 0 : movement === "right" ? 2 : 1;
      if (q[to] && q[to].byApproach[from] !== undefined) {
        q[to].byApproach[from][lane] += 1;
        const vert = Math.abs(NODE_MAP[to].x - NODE_MAP[from].x) < Math.abs(NODE_MAP[to].y - NODE_MAP[from].y);
        if (lane === 0) q[to].totals.l++;
        if (vert) q[to].totals.v++; else q[to].totals.h++;
      }
    });
    return q;
  }

  /* compute durations (proportional simple) */
  function computeDurations(prevDur, totals) {
    const base = [DEFAULT_GREEN, DEFAULT_GREEN, 1200];
    const v = totals.v||0, h = totals.h||0, l = totals.l||0;
    const qinf = [v*300, h*300, l*300];
    const raw = [base[0]+qinf[0], base[1]+qinf[1], base[2]+qinf[2]];
    const sum = raw.reduce((a,b)=>a+b,0) || 1;
    const avail = Math.max(300, base.reduce((a,b)=>a+b,0) - 3*DEFAULT_AMBER);
    let alloc = raw.map(r => Math.round((r/sum) * avail));
    alloc = alloc.map(d => clamp(d, MIN_PHASE, 20000));
    const alpha = 0.66;
    return { durations: [0,1,2].map(i => Math.round(alpha*alloc[i] + (1-alpha)*(prevDur && prevDur[i] ? prevDur[i] : base[i]))), method: "proportional" };
  }

  /* apply lamp rules: only one road pair is green or left-protected */
  function applyLampRules(signalsState) {
    const next = JSON.parse(JSON.stringify(signalsState));
    Object.keys(next).forEach(idStr=>{
      const ent = next[idStr];
      const phase = ent.manual ? ent.manualPhase : ent.phase;
      const t = ent.timer || 0;
      const dur = ent.durations ? ent.durations[phase] : DEFAULT_GREEN;
      Object.keys(ent.approaches).forEach(from => { ent.approaches[from].allowed = [false,false,false]; ent.approaches[from].lamp = "red"; });

      function isVertical(fromId, thisId) {
        const A = NODE_MAP[fromId], B = NODE_MAP[thisId];
        if (!A || !B) return false;
        return Math.abs(B.x - A.x) < Math.abs(B.y - A.y);
      }

      if (t < dur) {
        Object.keys(ent.approaches).forEach(from => {
          const vert = isVertical(Number(from), Number(idStr));
          if (phase === 0 && vert) { ent.approaches[from].allowed = [false,true,true]; ent.approaches[from].lamp = "green"; }
          if (phase === 1 && !vert) { ent.approaches[from].allowed = [false,true,true]; ent.approaches[from].lamp = "green"; }
          if (phase === 2) { ent.approaches[from].allowed = [true,false,false]; ent.approaches[from].lamp = "green"; }
        });
      } else if (t < dur + DEFAULT_AMBER) {
        Object.keys(ent.approaches).forEach(from => { ent.approaches[from].lamp = "orange"; });
      } else {
        Object.keys(ent.approaches).forEach(from => { ent.approaches[from].lamp = "red"; ent.approaches[from].allowed = [false,false,false]; });
      }
    });
    return next;
  }

  /* ---------------- Main RAF loop ---------------- */
  useEffect(()=>{
    lastNowRef.current = performance.now();

    function step(nowPerf) {
      const dt = (nowPerf - lastNowRef.current) * simSpeed;
      lastNowRef.current = nowPerf;

      const queues = computeQueues(vehiclesRef.current || []);

      // update signals (adaptive durations) and phases
      setSignals(prev => {
        const copy = JSON.parse(JSON.stringify(prev || {}));
        Object.keys(copy).forEach(idStr=>{
          const ent = copy[idStr];
          ent.approaches = ent.approaches || {};
          const prevDur = ent.durations ? ent.durations.slice() : [DEFAULT_GREEN, DEFAULT_GREEN, 1200];
          const totals = queues[idStr] ? queues[idStr].totals : { v:0,h:0,l:0 };

          if (adaptive && !ent.manual) {
            const outcome = useWebster ? computeDurations(prevDur, totals) : computeDurations(prevDur, totals);
            ent.durations = outcome.durations.slice();
            ent.changeLog = `${outcome.method} Q:${totals.v}/${totals.h}/${totals.l}`;
          }

          if (running) {
            ent.timer = (ent.timer || 0) + dt;
            if (ent.manual) {
              const green = ent.manualDur || ent.durations[ent.manualPhase] || DEFAULT_GREEN;
              if (ent.timer >= green + DEFAULT_AMBER) { ent.timer = 0; ent.manual = false; ent.phase = ent.manualPhase; }
              else ent.phase = ent.manualPhase;
            } else {
              const p = ent.phase || 0;
              const dur = (ent.durations && ent.durations[p]) || DEFAULT_GREEN;
              // if no demand in this phase, fast-skip to next phase (keeps flow)
              const demand = p===0 ? totals.v : p===1 ? totals.h : totals.l;
              if (demand === 0 && ent.timer >= Math.min(400, dur)) ent.timer = dur; // skip quicker
              if (ent.timer >= dur + DEFAULT_AMBER) { ent.timer = 0; ent.phase = (p + 1) % 3; }
            }
          }
        });
        const applied = applyLampRules(copy);
        signalsRef.current = applied;
        return applied;
      });

      // priority preempt (ambulance) - if enabled and vehicle close to intersection, preempt that intersection
      if (priorityEnabled && running) {
        vehiclesRef.current.forEach(v=>{
          if (!v || !v.nodePath) return;
          if (v.nodeIndex >= v.nodePath.length - 1) return;
          if (v.type !== "ambulance") return;
          // if very close to entering an intersection, force that intersection to allow its movement
          if (v.t > 0.75) {
            const from = v.nodePath[v.nodeIndex], to = v.nodePath[v.nodeIndex+1];
            setSignals(prev => {
              const copy = JSON.parse(JSON.stringify(prev||{}));
              if (!copy[to]) return prev;
              // compute movement
              const nextNode = v.nodePath[v.nodeIndex+2];
              let movement = "straight";
              if (nextNode) {
                const A = NODE_MAP[from], B = NODE_MAP[to], C = NODE_MAP[nextNode];
                if (A && B && C) {
                  const d1 = { x: B.x - A.x, y: B.y - A.y }, d2 = { x: C.x - B.x, y: C.y - B.y };
                  const cross = d1.x * d2.y - d1.y * d2.x;
                  if (cross > 0) movement = "left";
                  else if (cross < 0) movement = "right";
                }
              }
              const vert = Math.abs(NODE_MAP[to].x - NODE_MAP[from].x) < Math.abs(NODE_MAP[to].y - NODE_MAP[from].y);
              let desiredPhase = 0;
              if (movement === "left") desiredPhase = 2;
              else desiredPhase = vert ? 0 : 1;
              copy[to].manual = true;
              copy[to].manualPhase = desiredPhase;
              copy[to].manualDur = Math.max(800, priorityDuration);
              copy[to].timer = 0;
              copy[to].changeLog = `Preempt for ${v.type} ${v.name}`;
              // end preempt after duration
              setTimeout(()=> setSignals(s => {
                const c = JSON.parse(JSON.stringify(s));
                if (c[to]) { c[to].manual = false; c[to].timer = 0; c[to].changeLog = `Preempt ended`; }
                return c;
              }), Math.max(600, priorityDuration));
              return copy;
            });
          }
        });
      }

      // vehicle motion & queuing
      if (running) {
        setVehicles(prev => {
          const updated = prev.map(v => {
            if (!v || !v.nodePath) return null;
            // finished / despawn
            if (v.nodeIndex >= v.nodePath.length - 1) {
              if (!v.finishedAt) { v.finishedAt = nowMs(); return v; }
              if (nowMs() - v.finishedAt > 900) return null;
              return v;
            }
            const from = v.nodePath[v.nodeIndex], to = v.nodePath[v.nodeIndex+1];
            const A = NODE_MAP[from], B = NODE_MAP[to];
            if (!A || !B) return null;
            const dx = B.x - A.x, dy = B.y - A.y;
            const segLen = Math.hypot(dx,dy);
            const t_stop = Math.max(0, (segLen - STOP_LINE) / segLen);

            // detect movement type for lane choice
            const nextNode = v.nodePath[v.nodeIndex+2];
            let movement = "straight";
            if (nextNode) {
              const C = NODE_MAP[nextNode];
              if (A && B && C) {
                const d1 = { x: B.x - A.x, y: B.y - A.y }, d2 = { x: C.x - B.x, y: C.y - B.y };
                const cross = d1.x * d2.y - d1.y * d2.x;
                if (cross > 0) movement = "left"; else if (cross < 0) movement = "right";
              }
            }
            const laneIndex = movement === "left" ? 0 : movement === "right" ? 2 : 1;
            v.laneIndex = laneIndex;

            const willEnter = v.t + v.speed * (dt/16) >= 1 - 0.008;

            if (willEnter) {
              const sig = signalsRef.current && signalsRef.current[to];
              let allowed = true;
              if (sig && sig.approaches && sig.approaches[from]) {
                const appr = sig.approaches[from];
                allowed = !!(appr.lamp === "green" && appr.allowed && appr.allowed[laneIndex]);
              }
              // occupancy at intersection to prevent overlap
              if (NODE_MAP[to] && NODE_MAP[to].isIntersection) {
                const occ = occupancyRef.current[to] || 0;
                const cap = 1; // allow one vehicle "inside" intersection per approach to avoid overlap
                if (occ >= cap) allowed = false;
              }
              if (!allowed) {
                if (!v.queuedSince) v.queuedSince = nowMs();
                v.t = Math.min(v.t, t_stop);
                v.stopped = true;
                return v;
              } else {
                if (v.stopped && v.queuedSince) {
                  const waitMs = nowMs() - v.queuedSince;
                  setSignals(prevS => {
                    const s = JSON.parse(JSON.stringify(prevS));
                    if (s[to]) {
                      s[to].stats = s[to].stats || { passed:0,left:0,straight:0,right:0, sumWaitMs:0, waitCount:0, maxWaitMs:0 };
                      s[to].stats.passed++;
                      if (movement === "left") s[to].stats.left++;
                      else if (movement === "right") s[to].stats.right++;
                      else s[to].stats.straight++;
                      s[to].stats.sumWaitMs = (s[to].stats.sumWaitMs || 0) + waitMs;
                      s[to].stats.waitCount = (s[to].stats.waitCount || 0) + 1;
                      s[to].stats.maxWaitMs = Math.max(s[to].stats.maxWaitMs || 0, waitMs);
                      s[to].recent = (s[to].recent || []).concat([{ vehicle: v.name, type: v.type, movement, waitMs, time: new Date().toISOString() }]).slice(-400);
                    }
                    return s;
                  });
                  setRecords(r => {
                    const rec = { vehicle: v.name, type: v.type, from, to, movement, waitMs, time: new Date().toISOString() };
                    const out = (r||[]).concat(rec);
                    return out.slice(Math.max(0, out.length - MAX_RECORDS_KEEP));
                  });
                  v.queuedSince = null;
                }
                v.stopped = false;
              }
            }

            // advance
            if (!v.stopped) v.t += v.speed * (dt/16);

            if (v.t >= 1) {
              // leaving previous intersection occupancy
              if (NODE_MAP[from] && NODE_MAP[from].isIntersection) occupancyRef.current[from] = Math.max(0, (occupancyRef.current[from]||0) - 1);
              v.nodeIndex += 1;
              v.t = 0;
              // entering intersection occupancy
              if (NODE_MAP[v.nodePath[v.nodeIndex]] && NODE_MAP[v.nodePath[v.nodeIndex]].isIntersection) {
                const nid = v.nodePath[v.nodeIndex];
                occupancyRef.current[nid] = (occupancyRef.current[nid] || 0) + 1;
              }
              // if reached spawn node (destination), mark finished
              if (SPAWN_NODES.includes(v.nodePath[v.nodeIndex])) {
                if (!v.finishedAt) v.finishedAt = nowMs();
              }
            }
            return v;
          }).filter(Boolean);
          vehiclesRef.current = updated;
          return updated;
        });
      }

      rafRef.current = requestAnimationFrame(step);
    }

    rafRef.current = requestAnimationFrame(step);
    return () => cancelAnimationFrame(rafRef.current);
  }, [running, simSpeed, adaptive, useWebster, priorityEnabled, priorityDuration, NODE_MAP, INTERSECTIONS, LINKS, SPAWN_NODES]);

  /* ---------------- Export / Reset helpers ---------------- */
  function exportRecords() {
    if (!records || records.length === 0) { alert("No records"); return; }
    if (!XLSX) { alert("xlsx not installed. Run: npm install xlsx to enable export."); return; }
    const ws = XLSX.utils.json_to_sheet(records); const wb = XLSX.utils.book_new(); XLSX.utils.book_append_sheet(wb, ws, "records"); XLSX.writeFile(wb, "records.xlsx");
  }
  function resetAll() {
    setVehicles([]); setSignals(prev => {
      const s = JSON.parse(JSON.stringify(prev || {}));
      Object.keys(s).forEach(k => { s[k].phase = 0; s[k].timer = 0; s[k].manual = false; s[k].recent = []; s[k].stats = { passed:0,left:0,straight:0,right:0 }; });
      signalsRef.current = s;
      return s;
    });
    setRecords([]); arrivalRef.current = {}; occupancyRef.current = {}; vehicleIdCounter.current = 1;
  }

  function manualPreempt(nodeId, phase) {
    setSignals(prev => {
      const copy = JSON.parse(JSON.stringify(prev));
      if (!copy[nodeId]) return prev;
      copy[nodeId].manual = true; copy[nodeId].manualPhase = phase; copy[nodeId].manualDur = 3000; copy[nodeId].timer = 0; copy[nodeId].changeLog = `Manual P${phase}`;
      setTimeout(()=> setSignals(s => { const c = JSON.parse(JSON.stringify(s)); if (c[nodeId]) { c[nodeId].manual = false; c[nodeId].timer = 0; c[nodeId].changeLog = `Manual ended`; } return c; }), 3000);
      return copy;
    });
  }

  /* ---------------- Render ---------------- */
  const topBtn = { padding:"8px 12px", background:"#0f2430", border:"1px solid #1e3340", color:"#dbeafe", borderRadius:6 };
  const panelBtn = { padding:"6px 8px", marginRight:6, background:"#0b2330", border:"1px solid #142c3a", color:"#dbeafe", borderRadius:6 };
  const tinyBtn = { padding:"4px 6px", background:"#0b2330", border:"1px solid #102330", color:"#cfe7ff", borderRadius:6 };
  const viewPaddingX = 220, viewPaddingY = 160;
  const svgW = 1000, svgH = 760;

  function avgWait(stats){ return (stats && stats.waitCount>0) ? Math.round(stats.sumWaitMs / stats.waitCount) : 0; }

  return (
    <div style={{ display:"flex", flexDirection:"column", height:"100vh", fontFamily:"Inter, Arial, sans-serif" }}>
      <div style={{ height:56, background:"#0b1120", color:"#e6eef8", display:"flex", alignItems:"center", padding:"8px 12px" }}>
        <div style={{ fontWeight:700 }}>TrafficSim — Grid (3×3)</div>
        <div style={{ marginLeft:12, color:"#98a6bb" }}>Vehicles: {vehicles.length} • Records: {records.length}</div>
        <div style={{ marginLeft:"auto", display:"flex", gap:8 }}>
          <button onClick={()=>setRunning(r=>!r)} style={topBtn}>{running? "Pause":"Resume"}</button>
          <button onClick={resetAll} style={topBtn}>Reset</button>
          <button onClick={exportRecords} style={topBtn}>Export</button>
        </div>
      </div>

      <div style={{ display:"flex", flex:1, minHeight:0 }}>
        {/* left controls */}
        <div style={{ width:320, background:"#071428", color:"#dbeafe", padding:12, overflow:"auto" }}>
          <h4 style={{ margin:4 }}>Controls</h4>
          <div>
            <div style={{ display:"flex", justifyContent:"space-between", marginBottom:6 }}>
              <div>Sim speed</div>
              <select value={simSpeed} onChange={e=>setSimSpeed(Number(e.target.value))} style={{ background:"#0b2130", color:"#dbeafe" }}>
                <option value={0.5}>0.5x</option><option value={1}>1x</option><option value={2}>2x</option>
              </select>
            </div>
            <div style={{ display:"flex", justifyContent:"space-between", marginBottom:6 }}>
              <div>Spawn interval (ms)</div><input type="number" value={spawnInterval} onChange={e=>setSpawnInterval(Math.max(80, Number(e.target.value||1200)))} style={{ width:96 }} />
            </div>
            <div style={{ display:"flex", justifyContent:"space-between", marginBottom:6 }}>
              <div>Max vehicles</div><input type="number" value={maxVehicles} onChange={e=>setMaxVehicles(Math.max(1, Number(e.target.value||60)))} style={{ width:96 }} />
            </div>
          </div>

          <hr style={{ borderColor:"#0b2335", margin:"12px 0" }} />
          <div>
            <div style={{ fontSize:13, fontWeight:600 }}>Spawn weights</div>
            {Object.keys(spawnWeights).map(k => (
              <div key={k} style={{ display:"flex", alignItems:"center", gap:8, marginTop:6 }}>
                <div style={{ width:64, textTransform:"capitalize" }}>{k}</div>
                <input type="range" min={0} max={1} step={0.01} value={spawnWeights[k]} onChange={e=>setSpawnWeights(s=>({...s,[k]:Number(e.target.value)}))} style={{ flex:1 }} />
                <div style={{ width:40 }}>{Math.round(spawnWeights[k]*100)}%</div>
              </div>
            ))}
            <div style={{ fontSize:11, color:"#93b1c7", marginTop:6 }}>Vehicles spawn only at top-left and bottom-right corners.</div>
            <div style={{ marginTop:8 }}><button onClick={()=>{ setVehicles(v=>[...v, createVehicleCorner()]); }} style={panelBtn}>Spawn One Vehicle</button></div>
          </div>

          <hr style={{ borderColor:"#0b2335", margin:"12px 0" }} />
          <div>
            <h5 style={{ margin:"6px 0" }}>Algorithms & Priority</h5>
            <label style={{ display:"block" }}><input type="checkbox" checked={adaptive} onChange={e=>setAdaptive(e.target.checked)} /> Adaptive timing</label>
            <label style={{ display:"block" }}><input type="checkbox" checked={useWebster} onChange={e=>setUseWebster(e.target.checked)} /> Use Webster (approx)</label>
            <label style={{ display:"block" }}><input type="checkbox" checked={priorityEnabled} onChange={e=>setPriorityEnabled(e.target.checked)} /> Enable ambulance preempt</label>
            <div style={{ marginTop:8, display:"flex", gap:8 }}>
              <div style={{ flex:1 }}>Preempt duration (ms)</div>
              <input type="number" value={priorityDuration} onChange={e=>setPriorityDuration(Math.max(200, Number(e.target.value||3500)))} style={{ width:90 }} />
            </div>
          </div>
        </div>

        {/* center map */}
        <div style={{ flex:1, padding:12, background:"#01121a", overflow:"auto" }}>
          <div style={{ background:"#071724", borderRadius:8, padding:12 }}>
            <svg width="100%" height="720" viewBox={`0 0 ${svgW} ${svgH}`} preserveAspectRatio="xMidYMid meet">
              <rect x={0} y={0} width={svgW} height={svgH} fill="#071724" />
              {/* roads */}
              {LINKS.map((link, idx) => {
                const a = link[0], b = link[1];
                const A = INTERSECTIONS.find(x => x.id === a), B = INTERSECTIONS.find(x => x.id === b);
                if (!A || !B) return null;
                const dx = B.x - A.x, dy = B.y - A.y, ang = Math.atan2(dy, dx);
                return <g key={idx}>
                  {[0,1,2].map(li=>{
                    const offset = (-44/2) + (li+0.5)*(44/3);
                    const ox = -Math.sin(ang)*offset, oy = Math.cos(ang)*offset;
                    return <line key={li} x1={A.x + ox + viewPaddingX} y1={A.y + oy + viewPaddingY} x2={B.x + ox + viewPaddingX} y2={B.y + oy + viewPaddingY} stroke="#394249" strokeWidth={12} strokeLinecap="round" />;
                  })}
                </g>;
              })}

              {/* intersections & lamps */}
              {INTERSECTIONS.map(n => {
                const ent = signals[n.id] || { approaches:{} };
                return <g key={n.id} transform={`translate(${n.x + viewPaddingX}, ${n.y + viewPaddingY})`}>
                  <rect x={-48} y={-48} width={96} height={96} rx={6} fill="#071724" stroke="#1e2f3a" />
                  <text x={0} y={6} fill="#e6eef8" fontSize={12} textAnchor="middle">#{n.id}</text>
                  {Object.keys(ent.approaches || {}).map(fromStr => {
                    const from = Number(fromStr);
                    const F = INTERSECTIONS.find(x => x.id === from) || { x:0, y:0 };
                    const dx = n.x - F.x, dy = n.y - F.y, ang = Math.atan2(dy, dx);
                    const ax = Math.cos(ang)*(STOP_LINE+26), ay = Math.sin(ang)*(STOP_LINE+26);
                    const appr = ent.approaches[fromStr] || { lamp:"red", allowed:[false,false,false] };
                    const lamp = appr.lamp || "red";
                    const allowed = appr.allowed || [false,false,false];
                    const stopColor = lamp === "green" ? "#16a34a" : (lamp==="orange" ? "#f59e0b" : "#ef4444");
                    return <g key={fromStr} transform={`translate(${ax},${ay}) rotate(${(ang*180/Math.PI).toFixed(2)})`}>
                      <rect x={-36} y={-6} width={72} height={6} rx={2} fill={stopColor} />
                      <g transform="translate(0,-22)">
                        <rect x={-30} y={-16} width={60} height={32} rx={6} fill="#041826" stroke="#102836" />
                        <g transform="translate(-12,0)"><circle r={6} fill={allowed[0] && lamp==="green" ? "#10b981" : "#0b1720"} stroke="#000" /></g>
                        <g transform="translate(0,0)"><circle r={6} fill={allowed[1] && lamp==="green" ? "#10b981" : "#0b1720"} stroke="#000" /></g>
                        <g transform="translate(12,0)"><circle r={6} fill={allowed[2] && lamp==="green" ? "#10b981" : "#0b1720"} stroke="#000" /></g>
                      </g>
                    </g>;
                  })}
                </g>;
              })}

              {/* vehicles */}
              {vehicles.map(v => {
                if (!v || !v.nodePath) return null;
                const idx = v.nodeIndex;
                const path = v.nodePath;
                const from = path[idx], to = path[Math.min(idx+1, path.length-1)];
                const A = NODE_MAP[from], B = NODE_MAP[to];
                if (!A || !B) return null;
                const pos = { x: A.x + (B.x - A.x) * v.t + viewPaddingX, y: A.y + (B.y - A.y) * v.t + viewPaddingY };
                const dx = B.x - A.x, dy = B.y - A.y, ang = Math.atan2(dy, dx);
                const offset = (-44/2) + (v.laneIndex + 0.5) * (44/3);
                const ox = -Math.sin(ang) * offset, oy = Math.cos(ang) * offset;
                const deg = ang * 180 / Math.PI;
                const h = v.spec.length, w = v.spec.width;
                return <g key={v.id} transform={`translate(${pos.x + ox}, ${pos.y + oy}) rotate(${deg})`}>
                  <rect x={-h/2} y={-w/2} width={h} height={w} rx={2} fill={v.spec.color} stroke="#000" strokeWidth={0.8} />
                </g>;
              })}
            </svg>
          </div>
        </div>

        {/* right analysis */}
        <div style={{ width:420, background:"#071428", color:"#dbeafe", padding:12, overflow:"auto" }}>
          <h4 style={{ margin:4 }}>Analysis & Reports</h4>

          <div style={{ background:"#081826", padding:8, borderRadius:8 }}>
            <div style={{ display:"flex", justifyContent:"space-between" }}>
              <div><strong>Totals</strong></div>
              <div>Veh: <strong>{vehicles.length}</strong> • Recs: <strong>{records.length}</strong></div>
            </div>
            <div style={{ marginTop:8 }}>
              <button onClick={()=>setRunning(r=>!r)} style={panelBtn}>{running? "Pause":"Resume"}</button>
              <button onClick={resetAll} style={panelBtn}>Reset</button>
              <button onClick={exportRecords} style={panelBtn}>Export</button>
            </div>
          </div>

          <div style={{ height:10 }} />

          <div style={{ background:"#081826", padding:8, borderRadius:8 }}>
            <div style={{ fontWeight:700 }}>Intersections summary</div>
            <div style={{ maxHeight:380, overflow:"auto", marginTop:8 }}>
              {INTERSECTIONS.map(n => {
                const ent = signals[n.id] || { stats:{}, changeLog:"-" };
                const stats = ent.stats || { passed:0,left:0,straight:0,right:0, maxWaitMs:0, sumWaitMs:0, waitCount:0 };
                return <div key={n.id} style={{ padding:"8px 4px", borderBottom:"1px dashed #0b2836" }}>
                  <div style={{ display:"flex", justifyContent:"space-between" }}>
                    <div style={{ fontWeight:700 }}>#{n.id}</div>
                    <div style={{ fontSize:12 }}>{ent.changeLog}</div>
                  </div>
                  <div style={{ marginTop:6, display:"flex", gap:8 }}>
                    <div style={{ flex:1 }}>
                      <div style={{ fontSize:12 }}>Passed: {stats.passed}</div>
                      <div style={{ fontSize:12 }}>L:{stats.left} S:{stats.straight} R:{stats.right}</div>
                    </div>
                    <div style={{ width:140, textAlign:"right", fontSize:12 }}>
                      Max wait: <strong>{Math.round(stats.maxWaitMs||0)} ms</strong><br/>
                      <button onClick={()=>setSelectedIntersection(n.id)} style={{ ...panelBtn, marginTop:6 }}>Open</button>
                    </div>
                  </div>
                </div>;
              })}
            </div>
          </div>

          {selectedIntersection && (() => {
            const ent = signals[selectedIntersection] || { recent:[], stats:{} };
            const stats = ent.stats || { passed:0,left:0,straight:0,right:0, maxWaitMs:0, sumWaitMs:0, waitCount:0 };
            return (
              <div style={{ background:"#081826", padding:10, borderRadius:8, marginTop:8 }}>
                <div style={{ display:"flex", justifyContent:"space-between" }}>
                  <div style={{ fontWeight:700 }}>Intersection {selectedIntersection} — Detailed</div>
                  <button onClick={()=>setSelectedIntersection(null)} style={tinyBtn}>Close</button>
                </div>
                <div style={{ marginTop:8 }}>
                  <div>Phase: <strong>{ent.phase}</strong> • Durations: <strong>{ent.durations?ent.durations.map(d=>Math.round(d)).join(" / "):"-"}</strong></div>
                  <div style={{ marginTop:6 }}>Recent change: {ent.changeLog}</div>
                </div>
                <div style={{ marginTop:8 }}>
                  <div style={{ fontWeight:700 }}>Recent vehicles (last 400)</div>
                  <div style={{ maxHeight:240, overflow:"auto", marginTop:6 }}>
                    {(ent.recent||[]).slice().reverse().map((r,i)=>(
                      <div key={i} style={{ padding:"6px 0", borderBottom:"1px dashed #0b2836" }}>
                        <div style={{ fontSize:13 }}><strong>{r.vehicle}</strong> ({r.type}) • {r.movement.toUpperCase()}</div>
                        <div style={{ fontSize:12, color:"#9fb3cf" }}>wait {Math.round(r.waitMs)} ms • {new Date(r.time).toLocaleTimeString()}</div>
                      </div>
                    ))}
                    {(ent.recent||[]).length === 0 && <div style={{ color:"#7c99b2" }}>No recent vehicles recorded here.</div>}
                  </div>
                </div>
              </div>
            );
          })()}

        </div>
      </div>
    </div>
  );
}

/* ---------------- small utility used above (create single vehicle button) ---------------- */
function createVehicleCorner() {
  // fallback quick helper (not tightly coupled to component state) - used for manual spawn button
  // this helper returns a minimal object; main spawn loop uses createVehicleCorner logic inside the component.
  return {
    id: `v-manual-${Math.random().toString(36).slice(2,8)}`,
    name: randName(),
    type: "car",
    spec: VEHICLE_TYPES.car,
    nodePath: null,
    nodeIndex: 0,
    t: 0,
    speed: 0.0012,
    laneIndex: 1,
    stopped: false,
    queuedSince: null,
    finishedAt: null
  };
}
