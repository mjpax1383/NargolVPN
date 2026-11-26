(() => {
  const cfg = window.VPNBOT_CONFIG || {};
  const apiBase = (cfg.apiBase || "").replace(/\/$/, "");
  const refreshMs = Math.max(30, Number(cfg.refreshSeconds || 90)) * 1000;

  const state = { items: [], proto: "all", query: "", onlyIr: false, info: null };

  const $ = (id) => document.getElementById(id);

  async function getJson(path) {
    const response = await fetch(apiBase + path, { headers: { accept: "application/json" } });
    if (!response.ok) throw new Error("HTTP " + response.status);
    return response.json();
  }

  async function load() {
    try {
      const [data, info] = await Promise.all([getJson("/api/configs"), getJson("/api/info").catch(() => null)]);
      state.items = Array.isArray(data.items) ? data.items : [];
      state.info = info;
      render(data.generated_at || data.updated_at);
      $("live-dot").className = "dot live";
    } catch (error) {
      $("live-dot").className = "dot dead";
      $("meta").textContent = "اتصال به سرویس برقرار نشد: " + error.message;
      $("empty").hidden = state.items.length > 0;
    }
  }

  function render(generatedAt) {
    const items = state.items;
    $("stats").hidden = items.length === 0;
    $("subs").hidden = items.length === 0;
    $("empty").hidden = items.length > 0;

    const irCount = items.filter((item) => item.works_ir).length;
    const fast = items.filter((item) => Number(item.latency_ms) > 0 && Number(item.latency_ms) < 400).length;
    const protos = new Set(items.map((item) => item.proto));
    $("stat-alive").textContent = items.length;
    $("stat-ir").textContent = irCount;
    $("stat-fast").textContent = fast;
    $("stat-proto").textContent = protos.size;

    if (generatedAt) {
      const when = new Date(Number(generatedAt) * 1000);
      const minutes = Math.max(0, Math.round((Date.now() - when.getTime()) / 60000));
      $("meta").textContent = "آخرین بروزرسانی " + minutes + " دقیقه پیش · " + items.length + " کانفیگ زنده";
    }

    // Without a vantage point inside Iran the mirror would be an empty file: hide it instead.
    const hasIr = Number(irCount) > 0;
    const irButton = document.querySelector(".sub[data-copy=\"__IR__\"]");
    if (irButton) irButton.hidden = !hasIr;
    const irToggle = $("only-ir");
    if (irToggle && irToggle.closest("label")) irToggle.closest("label").hidden = !hasIr;
    const irStat = $("stat-ir");
    if (irStat && irStat.closest(".stat")) irStat.closest(".stat").hidden = !hasIr;

    const base = (state.info && state.info.base) || apiBase;
    document.querySelectorAll(".sub").forEach((button) => {
      const key = button.dataset.copy;
      const suffix = key === "__IR__" ? "/sub/ir" : key === "__GLOBAL__" ? "/sub/global" : "/sub/all";
      button.dataset.value = base + suffix;
    });

    paint();
  }

  function paint() {
    const query = state.query.trim().toLowerCase();
    const filtered = state.items.filter((item) => {
      if (state.proto !== "all" && item.proto !== state.proto) return false;
      if (state.onlyIr && !item.works_ir) return false;
      if (!query) return true;
      return String(item.host || "").toLowerCase().indexOf(query) >= 0;
    });

    const list = $("list");
    list.textContent = "";
    const fragment = document.createDocumentFragment();

    filtered.forEach((item) => {
      const row = document.createElement("div");
      row.className = "row";

      const proto = document.createElement("span");
      proto.className = "proto";
      proto.textContent = String(item.proto || "").toUpperCase();

      const host = document.createElement("span");
      host.className = "host";
      host.textContent = (item.host || "") + ":" + item.port;

      const latency = document.createElement("span");
      latency.className = "lat" + (Number(item.latency_ms) < 400 ? " fast" : "");
      latency.textContent = (item.latency_ms || "—") + " ms" + (item.works_ir ? " · IR" : "");

      const copy = document.createElement("button");
      copy.className = "copy";
      copy.textContent = "کپی";
      copy.addEventListener("click", () => copyText(item.uri || ""));

      row.append(proto, host, latency, copy);
      fragment.append(row);
    });

    list.append(fragment);
    $("empty").hidden = filtered.length > 0 || state.items.length === 0;
    if (filtered.length === 0 && state.items.length > 0) {
      $("empty").hidden = false;
      $("empty").textContent = "هیچ نتیجه‌ای با این فیلترها پیدا نشد.";
    }
  }

  async function copyText(text) {
    if (!text) return;
    try {
      await navigator.clipboard.writeText(text);
      toast("کپی شد");
    } catch (error) {
      const area = document.createElement("textarea");
      area.value = text;
      document.body.append(area);
      area.select();
      document.execCommand("copy");
      area.remove();
      toast("کپی شد");
    }
  }

  let toastTimer = 0;
  function toast(message) {
    const node = $("toast");
    node.textContent = message;
    node.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { node.hidden = true; }, 1600);
  }

  $("search").addEventListener("input", (event) => {
    state.query = event.target.value;
    paint();
  });

  $("proto-filters").addEventListener("click", (event) => {
    const button = event.target.closest(".chip");
    if (!button) return;
    state.proto = button.dataset.proto;
    document.querySelectorAll(".chip").forEach((chip) => chip.classList.toggle("active", chip === button));
    paint();
  });

  $("only-ir").addEventListener("change", (event) => {
    state.onlyIr = event.target.checked;
    paint();
  });

  $("subs").addEventListener("click", (event) => {
    const button = event.target.closest(".sub");
    if (button) copyText(button.dataset.value || "");
  });

  load();
  setInterval(load, refreshMs);
})();