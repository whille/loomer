/* Loomer Dashboard — vanilla JS, zero framework */
(function () {
  "use strict";

  // --- State ---
  const agentMap = {}; // name -> agent object
  let sse = null;

  // --- DOM refs ---
  const $tbody = document.getElementById("agent-tbody");
  const $table = document.getElementById("agent-table");
  const $empty = document.getElementById("empty-state");
  const $sseDot = document.getElementById("sse-dot");
  const $sseLabel = document.getElementById("sse-label");
  const $startForm = document.getElementById("start-form");
  const $planForm = document.getElementById("plan-form");
  const $dagPanel = document.getElementById("dag-panel");
  const $dagName = document.getElementById("dag-plan-name");
  const $logModal = document.getElementById("log-modal");
  const $logTitle = document.getElementById("log-modal-title");
  const $logBody = document.getElementById("log-modal-body");
  const $logClose = document.getElementById("log-modal-close");
  const $diffModal = document.getElementById("diff-modal");
  const $diffTitle = document.getElementById("diff-modal-title");
  const $diffBody = document.getElementById("diff-modal-body");
  const $diffClose = document.getElementById("diff-modal-close");
  const $riskModal = document.getElementById("risk-modal");
  const $riskTitle = document.getElementById("risk-modal-title");
  const $riskBody = document.getElementById("risk-modal-body");
  const $riskClose = document.getElementById("risk-modal-close");

  // --- Action buttons per status ---
  const ACTIONS = {
    PENDING: [],
    RUNNING: [{ action: "kill", label: "Kill", cls: "btn-danger" }],
    DONE: [{ action: "done", label: "Merge", cls: "btn-success" }],
    CRASHED: [{ action: "retry", label: "Retry", cls: "btn-warning" }],
    CONFLICTED: [
      { action: "retry", label: "Resolve", cls: "btn-warning" },
      { action: "kill", label: "Discard", cls: "btn-danger", query: "?clean=1" },
    ],
    STALE: [{ action: "retry", label: "Retry", cls: "btn-warning" }],
    REVIEW: [
      { action: "accept", label: "Accept", cls: "btn-success" },
      { action: "reject", label: "Reject", cls: "btn-danger" },
    ],
    ACCEPTED: [],
    REJECTED: [],
  };

  // 非运行状态均可 Delete（clean=1）
  const DELETE_ACTION = { action: "kill", label: "Delete", cls: "btn-danger", query: "?clean=1" };
  const NON_DELETABLE = new Set(["RUNNING", "PENDING"]);

  // --- API helpers ---
  async function apiPost(url) {
    const res = await fetch(url, { method: "POST" });
    const data = await res.json();
    if (!res.ok) throw new Error(data.message || data.error || "Request failed");
    return data;
  }

  async function fetchAgents() {
    const res = await fetch("/api/status");
    const agents = await res.json();
    for (const a of agents) agentMap[a.name] = a;
    renderAgents();
  }

  // --- Render ---
  function renderAgents() {
    const agents = Object.values(agentMap);
    $table.style.display = agents.length ? "" : "none";
    $empty.style.display = agents.length ? "none" : "";
    $tbody.innerHTML = "";

    // 按状态排序：active states first
    const order = { RUNNING: 0, REVIEW: 1, DONE: 2, CRASHED: 3, CONFLICTED: 4, STALE: 5, PENDING: 6, ACCEPTED: 7, REJECTED: 8 };
    agents.sort((a, b) => (order[a.status] ?? 9) - (order[b.status] ?? 9));

    for (const agent of agents) {
      const tr = document.createElement("tr");
      tr.dataset.name = agent.name;

      // name
      const tdName = document.createElement("td");
      tdName.innerHTML = '<span class="agent-name">' + esc(agent.name) + "</span>";
      tr.appendChild(tdName);

      // status badge + risk level for REVIEW
      const tdStatus = document.createElement("td");
      let statusHtml = '<span class="badge badge-' + esc(agent.status) + '">' + esc(agent.status) + "</span>";
      if (agent.status === "REVIEW" && agent.risk_assessment) {
        statusHtml += ' <span class="badge badge-risk-' + esc(agent.risk_assessment.level) + '">' + esc(agent.risk_assessment.level) + '</span>';
      }
      tdStatus.innerHTML = statusHtml;
      tr.appendChild(tdStatus);

      // branch
      const tdBranch = document.createElement("td");
      tdBranch.innerHTML =
        '<span class="agent-branch">' + esc(agent.branch || "-") + "</span>";
      tr.appendChild(tdBranch);

      // prompt
      const tdPrompt = document.createElement("td");
      tdPrompt.innerHTML =
        '<span class="agent-prompt" title="' + esc(agent.prompt || "") + '">' + esc(agent.prompt || "-") + "</span>";
      tr.appendChild(tdPrompt);

      // actions
      const tdActions = document.createElement("td");
      tdActions.className = "agent-actions";
      const btns = (ACTIONS[agent.status] || []).slice();
      if (!NON_DELETABLE.has(agent.status)) btns.push(DELETE_ACTION);
      for (const b of btns) {
        const btn = document.createElement("button");
        btn.className = "btn btn-icon " + b.cls;
        btn.textContent = b.label;
        btn.addEventListener("click", () => handleAction(agent.name, b.action, btn, b.query));
        tdActions.appendChild(btn);
      }
      // log + diff buttons for all agents
      const logBtn = document.createElement("button");
      logBtn.className = "btn btn-icon";
      logBtn.textContent = "Log";
      logBtn.addEventListener("click", () => showLog(agent.name));
      tdActions.appendChild(logBtn);

      const diffBtn = document.createElement("button");
      diffBtn.className = "btn btn-icon";
      diffBtn.textContent = "Diff";
      diffBtn.addEventListener("click", () => showDiff(agent.name));
      tdActions.appendChild(diffBtn);

      // risk button for REVIEW agents
      if (agent.status === "REVIEW") {
        const riskBtn = document.createElement("button");
        riskBtn.className = "btn btn-icon";
        riskBtn.textContent = "Risk";
        riskBtn.addEventListener("click", () => showRisk(agent.name));
        tdActions.appendChild(riskBtn);
      }

      tr.appendChild(tdActions);
      $tbody.appendChild(tr);
    }
  }

  function handleAction(name, action, btn, query) {
    btn.disabled = true;
    const url = "/api/" + action + "/" + encodeURIComponent(name) + (query || "");
    apiPost(url)
      .then(() => fetchAgents())
      .catch((err) => {
        alert(action + " failed: " + err.message);
      })
      .finally(() => {
        btn.disabled = false;
      });
  }

  // --- Log modal ---
  function showLog(name) {
    $logTitle.textContent = "Log: " + name;
    $logBody.textContent = "Loading...";
    $logModal.classList.add("active");

    fetch("/api/log/" + encodeURIComponent(name) + "?lines=100")
      .then((r) => r.json())
      .then((data) => {
        $logBody.textContent = data.log || "(empty)";
      })
      .catch((err) => {
        $logBody.textContent = "Error: " + err.message;
      });
  }

  // --- Diff modal ---
  function showDiff(name) {
    $diffTitle.textContent = "Diff: " + name;
    $diffBody.textContent = "Loading...";
    $diffModal.classList.add("active");

    fetch("/api/diff/" + encodeURIComponent(name) + "?mode=stat")
      .then((r) => r.json())
      .then((data) => {
        $diffBody.textContent = data.diff || "(no changes)";
      })
      .catch((err) => {
        $diffBody.textContent = "Error: " + err.message;
      });
  }

  // --- Risk Assessment modal ---
  function showRisk(name) {
    const agent = agentMap[name];
    const ra = agent && agent.risk_assessment;
    $riskTitle.textContent = "Risk Assessment: " + name;

    if (!ra) {
      $riskBody.textContent = "No risk assessment available.";
    } else {
      let html = '<div class="risk-overall">';
      html += '<span class="badge badge-risk-' + esc(ra.level) + '">' + esc(ra.level) + ' RISK</span>';
      html += "</div>";
      html += '<table class="risk-signal-table">';
      html += "<thead><tr><th>Signal</th><th>Level</th><th>Detail</th></tr></thead>";
      html += "<tbody>";
      for (const sig of ra.signals) {
        html += "<tr>";
        html += "<td>" + esc(sig.name) + "</td>";
        html += '<td><span class="badge badge-risk-' + esc(sig.level) + '">' + esc(sig.level) + "</span></td>";
        html += "<td>" + esc(sig.detail) + "</td>";
        html += "</tr>";
      }
      html += "</tbody></table>";
      $riskBody.innerHTML = html;
    }
    $riskModal.classList.add("active");
  }

  // --- Modal close ---
  function closeModal(overlay) {
    overlay.classList.remove("active");
  }

  $logClose.addEventListener("click", () => closeModal($logModal));
  $diffClose.addEventListener("click", () => closeModal($diffModal));
  $riskClose.addEventListener("click", () => closeModal($riskModal));
  $logModal.addEventListener("click", (e) => {
    if (e.target === $logModal) closeModal($logModal);
  });
  $diffModal.addEventListener("click", (e) => {
    if (e.target === $diffModal) closeModal($diffModal);
  });
  $riskModal.addEventListener("click", (e) => {
    if (e.target === $riskModal) closeModal($riskModal);
  });

  // --- Start form ---
  $startForm.addEventListener("submit", (e) => {
    e.preventDefault();
    const name = document.getElementById("input-name").value.trim();
    const prompt = document.getElementById("input-prompt").value.trim();
    if (!name || !prompt) return;

    const btn = $startForm.querySelector('button[type="submit"]');
    btn.disabled = true;

    fetch("/api/start", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name, prompt }),
    })
      .then((r) => r.json())
      .then((data) => {
        if (data.error) throw new Error(data.message || data.error);
        $startForm.reset();
        fetchAgents();
      })
      .catch((err) => alert("Start failed: " + err.message))
      .finally(() => {
        btn.disabled = false;
      });
  });

  // --- Plan form ---
  $planForm.addEventListener("submit", (e) => {
    e.preventDefault();
    const path = document.getElementById("input-plan-path").value.trim();
    if (!path) return;

    const btn = $planForm.querySelector('button[type="submit"]');
    btn.disabled = true;

    const body = path.endsWith(".json")
      ? { prdPath: path }
      : { path };

    fetch("/api/plan/run", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    })
      .then((r) => r.json())
      .then((data) => {
        if (data.error) throw new Error(data.message || data.error);
        $planForm.reset();
        loadPlan();
      })
      .catch((err) => alert("Plan failed: " + err.message))
      .finally(() => {
        btn.disabled = false;
      });
  });

  // --- DAG / Plan ---
  const STAT_DOTS = [
    { key: "done",      cls: "dot-done",      label: "done" },
    { key: "running",   cls: "dot-running",   label: "running" },
    { key: "pending",   cls: "dot-pending",   label: "pending" },
    { key: "crashed",   cls: "dot-crashed",   label: "crashed" },
    { key: "conflicted", cls: "dot-conflicted", label: "conflicted" },
    { key: "stale",     cls: "dot-stale",     label: "stale" },
    { key: "review",    cls: "dot-review",    label: "review" },
  ];

  function loadPlan() {
    fetch("/api/plan/status")
      .then((r) => r.json())
      .then((progress) => {
        if (!progress) {
          $dagPanel.style.display = "none";
          return;
        }
        $dagPanel.style.display = "";
        $dagName.textContent = progress.plan || "-";

        // 进度条
        const total = progress.total || 1;
        const done = progress.done || 0;
        const pct = Math.round(done / total * 100);
        const $bar = document.getElementById("dag-progress-bar");
        const $pct = document.getElementById("dag-progress-pct");
        if ($bar) $bar.style.width = pct + "%";
        if ($pct) $pct.textContent = pct + "%";

        // 统计圆点
        const $stats = document.getElementById("dag-stats");
        if ($stats) {
          $stats.innerHTML = STAT_DOTS.map(d =>
            '<span><i class="stat-dot ' + d.cls + '"></i>' + (progress[d.key] || 0) + " " + d.label + "</span>"
          ).join("");
        }

        // load DAG nodes+edges
        fetch("/api/plan/dag")
          .then((r) => r.json())
          .then((dag) => {
            renderDag(dag);
          });
      });
  }

  function renderDag(dag) {
    if (!dag || !dag.nodes) {
      $dagPanel.style.display = "none";
      return;
    }

    const svg = document.getElementById("dag-svg");
    // 清除旧节点/边（保留 defs）
    svg.querySelectorAll(".dag-node,.dag-edge").forEach(el => el.remove());

    const nodes = dag.nodes || [];
    const edges = dag.edges || [];

    // BFS 拓扑分层
    const layerMap = {};
    nodes.forEach(n => { layerMap[n.id] = 0; });

    let changed = true;
    let iterations = 0;
    while (changed && iterations < nodes.length + 1) {
      changed = false;
      iterations++;
      edges.forEach(e => {
        if (layerMap[e.to] <= layerMap[e.from]) {
          layerMap[e.to] = layerMap[e.from] + 1;
          changed = true;
        }
      });
    }

    const maxLayer = Math.max(0, ...Object.values(layerMap));
    const layers = Array.from({ length: maxLayer + 1 }, () => []);
    nodes.forEach(n => layers[layerMap[n.id]].push(n));

    const nodeW = 120, nodeH = 32, gapX = 40, gapY = 16, padX = 20, padY = 20;
    let maxW = 0;
    layers.forEach(layer => {
      const w = layer.length * nodeW + (layer.length - 1) * gapX;
      if (w > maxW) maxW = w;
    });

    svg.setAttribute("width", maxW + padX * 2);
    svg.setAttribute("height", (maxLayer + 1) * (nodeH + gapY) + padY * 2);

    // 计算节点位置
    const posMap = {};
    layers.forEach((layer, li) => {
      const layerW = layer.length * nodeW + (layer.length - 1) * gapX;
      const offsetX = (maxW - layerW) / 2 + padX;
      layer.forEach((n, ni) => {
        const x = offsetX + ni * (nodeW + gapX);
        const y = padY + li * (nodeH + gapY);
        posMap[n.id] = { x, y };
      });
    });

    // 绘制 bezier 边（带箭头）
    edges.forEach(e => {
      const from = posMap[e.from], to = posMap[e.to];
      if (!from || !to) return;
      const x1 = from.x + nodeW / 2, y1 = from.y + nodeH;
      const x2 = to.x + nodeW / 2, y2 = to.y;
      const midY = (y1 + y2) / 2;
      const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
      path.setAttribute("class", "dag-edge");
      path.setAttribute("d", "M" + x1 + "," + y1 + " C" + x1 + "," + midY + " " + x2 + "," + midY + " " + x2 + "," + y2);
      svg.appendChild(path);
    });

    // 绘制颜色编码节点
    nodes.forEach(n => {
      const pos = posMap[n.id];
      const g = document.createElementNS("http://www.w3.org/2000/svg", "g");
      g.setAttribute("class", "dag-node " + n.status.toLowerCase());
      g.setAttribute("transform", "translate(" + pos.x + "," + pos.y + ")");

      const rect = document.createElementNS("http://www.w3.org/2000/svg", "rect");
      rect.setAttribute("width", nodeW);
      rect.setAttribute("height", nodeH);
      g.appendChild(rect);

      const text = document.createElementNS("http://www.w3.org/2000/svg", "text");
      text.setAttribute("x", nodeW / 2);
      text.setAttribute("y", nodeH / 2);
      text.textContent = n.id;
      g.appendChild(text);

      svg.appendChild(g);
    });
  }

  // --- SSE ---
  function setupSSE() {
    sse = new EventSource("/api/events");

    sse.onopen = () => {
      $sseDot.classList.add("connected");
      $sseLabel.textContent = "connected";
      // 重连后全量刷新
      fetchAgents();
    };

    sse.onerror = () => {
      $sseDot.classList.remove("connected");
      $sseLabel.textContent = "disconnected";
    };

    sse.addEventListener("status", (e) => {
      try {
        const changed = JSON.parse(e.data);
        let needsFetch = false;
        for (const [name, status] of Object.entries(changed)) {
          if (agentMap[name]) {
            agentMap[name].status = status;
          } else {
            agentMap[name] = { name, status };
          }
          if (status === "REVIEW") needsFetch = true;
        }
        if (needsFetch) fetchAgents();
        else renderAgents();
      } catch { /* ignore parse errors */ }
    });
  }

  // --- Escape HTML ---
  function esc(str) {
    if (str == null) return "";
    return String(str)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  // --- Init ---
  fetchAgents();
  setupSSE();
  loadPlan();

  // Poll plan progress every 5s
  setInterval(loadPlan, 5000);
})();
