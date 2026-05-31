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
  const $dagProgress = document.getElementById("dag-progress");
  const $dagNodes = document.getElementById("dag-nodes");
  const $logModal = document.getElementById("log-modal");
  const $logTitle = document.getElementById("log-modal-title");
  const $logBody = document.getElementById("log-modal-body");
  const $logClose = document.getElementById("log-modal-close");
  const $diffModal = document.getElementById("diff-modal");
  const $diffTitle = document.getElementById("diff-modal-title");
  const $diffBody = document.getElementById("diff-modal-body");
  const $diffClose = document.getElementById("diff-modal-close");

  // --- Action buttons per status ---
  const ACTIONS = {
    PENDING: [],
    RUNNING: [{ action: "kill", label: "Kill", cls: "btn-danger" }],
    DONE: [{ action: "done", label: "Done", cls: "btn-success" }],
    CRASHED: [
      { action: "retry", label: "Retry", cls: "btn-warning" },
      { action: "kill", label: "Kill", cls: "btn-danger" },
    ],
    CONFLICTED: [
      { action: "retry", label: "Retry", cls: "btn-warning" },
      { action: "kill", label: "Kill", cls: "btn-danger" },
    ],
    STALE: [
      { action: "retry", label: "Retry", cls: "btn-warning" },
      { action: "kill", label: "Kill", cls: "btn-danger" },
    ],
    REVIEW: [
      { action: "accept", label: "Accept", cls: "btn-success" },
      { action: "reject", label: "Reject", cls: "btn-danger" },
    ],
    ACCEPTED: [],
    REJECTED: [],
  };

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

      // status badge
      const tdStatus = document.createElement("td");
      tdStatus.innerHTML =
        '<span class="badge badge-' + esc(agent.status) + '">' + esc(agent.status) + "</span>";
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
      const btns = ACTIONS[agent.status] || [];
      for (const b of btns) {
        const btn = document.createElement("button");
        btn.className = "btn btn-icon " + b.cls;
        btn.textContent = b.label;
        btn.addEventListener("click", () => handleAction(agent.name, b.action, btn));
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

      tr.appendChild(tdActions);
      $tbody.appendChild(tr);
    }
  }

  function handleAction(name, action, btn) {
    btn.disabled = true;
    const url = "/api/" + action + "/" + encodeURIComponent(name);
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

  // --- Modal close ---
  function closeModal(overlay) {
    overlay.classList.remove("active");
  }

  $logClose.addEventListener("click", () => closeModal($logModal));
  $diffClose.addEventListener("click", () => closeModal($diffModal));
  $logModal.addEventListener("click", (e) => {
    if (e.target === $logModal) closeModal($logModal);
  });
  $diffModal.addEventListener("click", (e) => {
    if (e.target === $diffModal) closeModal($diffModal);
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
        $dagProgress.textContent =
          "total: " + progress.total +
          " | running: " + progress.running +
          " | done: " + progress.done +
          " | pending: " + progress.pending +
          " | crashed: " + progress.crashed +
          " | review: " + progress.review;

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

    $dagNodes.innerHTML = "";
    for (const node of dag.nodes) {
      const div = document.createElement("div");
      div.className = "dag-node";
      div.innerHTML =
        '<span class="badge badge-' + esc(node.status) + '">' + esc(node.id) + "</span>";
      $dagNodes.appendChild(div);
    }

    // edges as text below nodes
    if (dag.edges && dag.edges.length > 0) {
      const edgeDiv = document.createElement("div");
      edgeDiv.style.marginTop = "8px";
      for (const edge of dag.edges) {
        const span = document.createElement("div");
        span.className = "dag-edge";
        span.textContent = edge.from + " → " + edge.to;
        edgeDiv.appendChild(span);
      }
      $dagNodes.appendChild(edgeDiv);
    }
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
        for (const [name, status] of Object.entries(changed)) {
          if (agentMap[name]) {
            agentMap[name].status = status;
          } else {
            // new agent, fetch full data
            agentMap[name] = { name, status };
          }
        }
        renderAgents();
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
