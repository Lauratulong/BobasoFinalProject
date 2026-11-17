const STORAGE_KEY = "laundryku_data_v1";

const money = n =>
  new Intl.NumberFormat("id-ID", {
    style: "currency",
    currency: "IDR",
    maximumFractionDigits: 0
  }).format(Number(n) || 0);

const today = () =>
  new Date(Date.now() - new Date().getTimezoneOffset() * 60000)
    .toISOString()
    .slice(0, 10);

const esc = s =>
  String(s).replace(/[&<>"']/g, c => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;"
  }[c]));

const seed = {
  customers: [],
  orders: []
};

/* ---------- Data ---------- */

function cloneSeed() {
  return {
    customers: seed.customers.map(c => ({ ...c })),
    orders: seed.orders.map(o => ({ ...o }))
  };
}

function loadData() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return cloneSeed();
    const parsed = JSON.parse(raw);
    if (
      parsed &&
      Array.isArray(parsed.customers) &&
      Array.isArray(parsed.orders)
    ) {
      return parsed;
    }
    return cloneSeed();
  } catch (e) {
    return cloneSeed();
  }
}

let db = loadData();

function save() {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(db));
}

function renderAll() {
  renderDashboard();
  renderOrders();
  renderCustomers();
  renderReports();
}

/* ---------- Helpers ---------- */

function nextId(list) {
  return list.length ? Math.max(...list.map(x => Number(x.id) || 0)) + 1 : 1;
}

function customerName(id) {
  return db.customers.find(c => c.id === Number(id))?.name || "Pelanggan dihapus";
}

function orderTotal(o) {
  return Math.round(Number(o.weight) * Number(o.price));
}

let toastTimer = null;

function toast(message) {
  const el = document.getElementById("toast");
  if (!el) return;
  el.textContent = message;
  el.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove("show"), 2600);
}

function statusClass(s) {
  return s === "Selesai"
    ? "status-selesai"
    : s === "Diproses"
      ? "status-diproses"
      : "status-menunggu";
}

function paymentClass(s) {
  return s === "Lunas" ? "pay-lunas" : "pay-belum";
}

function setText(id, value) {
  const el = document.getElementById(id);
  if (el) el.textContent = value;
}

function downloadCSV(filename, headers, rows) {
  const escapeCSV = val => {
    const raw = String(val ?? "");
    const safe = /^[=+\-@\t\r]/.test(raw) ? `'${raw}` : raw;
    return /[",\n\r]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
  };
  const csvContent =
    "\uFEFF" +
    [headers, ...rows].map(row => row.map(escapeCSV).join(",")).join("\r\n");

  const blob = new Blob([csvContent], { type: "text/csv;charset=utf-8;" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function exportOrdersCSV() {
  if (!db.orders.length) {
    toast("Belum ada data pesanan untuk diekspor.");
    return;
  }
  const headers = [
    "ID Pesanan",
    "Tanggal",
    "Pelanggan",
    "Layanan",
    "Berat (kg)",
    "Harga/kg (Rp)",
    "Total (Rp)",
    "Status",
    "Pembayaran",
    "Catatan"
  ];
  const rows = [...db.orders]
    .sort((a, b) => a.id - b.id)
    .map(o => [
      o.id,
      o.date,
      customerName(o.customerId),
      o.service,
      o.weight,
      o.price,
      orderTotal(o),
      o.status,
      o.payment,
      o.note || ""
    ]);
  downloadCSV(`pesanan-laundry-${today()}.csv`, headers, rows);
  toast("Data pesanan berhasil diekspor ke CSV.");
}

function exportCustomersCSV() {
  if (!db.customers.length) {
    toast("Belum ada data pelanggan untuk diekspor.");
    return;
  }
  const headers = [
    "ID Pelanggan",
    "Nama Pelanggan",
    "Nomor Telepon",
    "Alamat",
    "Jumlah Pesanan"
  ];
  const rows = [...db.customers]
    .sort((a, b) => a.id - b.id)
    .map(c => [
      c.id,
      c.name,
      c.phone,
      c.address,
      db.orders.filter(o => o.customerId === c.id).length
    ]);
  downloadCSV(`pelanggan-laundry-${today()}.csv`, headers, rows);
  toast("Data pelanggan berhasil diekspor ke CSV.");
}

/* ---------- Navigasi ---------- */

function showView(page) {
  document.querySelectorAll(".view").forEach(v => (v.hidden = v.dataset.view !== page));
  document
    .querySelectorAll(".nav-list a")
    .forEach(a => a.classList.toggle("active", a.dataset.page === page));

  const titles = {
    dashboard: "Dashboard",
    orders: "Manajemen Pesanan",
    customers: "Data Pelanggan",
    reports: "Laporan"
  };
  document.getElementById("top-title").textContent = titles[page] || "Dashboard";
  document.querySelector(".sidebar")?.classList.remove("open");
}

function navSetup() {
  document.querySelectorAll(".nav-list a").forEach(a =>
    a.addEventListener("click", e => {
      e.preventDefault();
      showView(a.dataset.page);
    })
  );

  const sidebar = document.querySelector(".sidebar");
  const menu = document.querySelector(".mobile-menu");
  menu?.addEventListener("click", e => {
    e.stopPropagation();
    sidebar?.classList.toggle("open");
  });

  document.addEventListener("click", e => {
    if (
      sidebar?.classList.contains("open") &&
      !sidebar.contains(e.target) &&
      e.target !== menu
    ) {
      sidebar.classList.remove("open");
    }
  });
}

/* ---------- Dashboard ---------- */

function renderDashboard() {
  const total = db.orders.length;
  const processing = db.orders.filter(o => o.status === "Diproses").length;
  const done = db.orders.filter(o => o.status === "Selesai").length;
  const revenue = db.orders
    .filter(o => o.payment === "Lunas")
    .reduce((s, o) => s + orderTotal(o), 0);

  setText("stat-orders", total);
  setText("stat-process", processing);
  setText("stat-done", done);
  setText("stat-revenue", money(revenue));

  const tbody = document.getElementById("recent-orders");
  if (tbody) {
    const rows = [...db.orders].sort((a, b) => b.id - a.id).slice(0, 5);
    tbody.innerHTML = rows.length
      ? rows
          .map(
            o =>
              `<tr><td><strong>#${o.id}</strong></td><td>${esc(customerName(o.customerId))}</td><td>${esc(o.service)}</td><td><span class="status ${statusClass(o.status)}">${o.status}</span></td><td>${money(orderTotal(o))}</td></tr>`
          )
          .join("")
      : `<tr><td colspan="5" class="empty">Belum ada pesanan.</td></tr>`;
  }
}

/* ---------- Pesanan ---------- */

function renderOrders() {
  const tbody = document.getElementById("orders-body");
  if (!tbody) return;

  const q = (document.getElementById("order-search")?.value || "").toLowerCase();
  const status = document.getElementById("status-filter")?.value || "";

  const rows = [...db.orders]
    .sort((a, b) => b.id - a.id)
    .filter(
      o =>
        (String(o.id).includes(q) ||
          customerName(o.customerId).toLowerCase().includes(q) ||
          o.service.toLowerCase().includes(q)) &&
        (!status || o.status === status)
    );

  tbody.innerHTML = rows.length
    ? rows
        .map(
          o =>
            `<tr><td><strong>#${o.id}</strong></td><td><div class="customer-cell"><span class="mini-avatar">${esc(customerName(o.customerId).trim().charAt(0).toUpperCase() || "?")}</span>${esc(customerName(o.customerId))}</div></td><td>${esc(o.service)}</td><td>${o.weight} kg</td><td>${money(orderTotal(o))}</td><td><span class="status ${statusClass(o.status)}">${o.status}</span></td><td><span class="pay ${paymentClass(o.payment)}">${o.payment}</span></td><td><div class="actions"><button class="icon-btn" title="Edit" onclick="editOrder(${o.id})">✎</button><button class="icon-btn" title="Hapus" onclick="deleteOrder(${o.id})">⌫</button></div></td></tr>`
        )
        .join("")
    : `<tr><td colspan="8" class="empty">Data pesanan tidak ditemukan.</td></tr>`;
}

function openOrderModal(id = null) {
  if (!db.customers.length) {
    toast("Tambahkan pelanggan terlebih dahulu.");
    showView("customers");
    openCustomerModal();
    return;
  }

  const modal = document.getElementById("order-modal");
  const form = document.getElementById("order-form");
  if (!modal || !form) return;

  form.reset();
  document.getElementById("order-id").value = id || "";
  document.getElementById("order-customer").innerHTML = db.customers
    .map(c => `<option value="${c.id}">${esc(c.name)}</option>`)
    .join("");

  const o = db.orders.find(x => x.id === id);
  document.getElementById("modal-title").textContent = o ? "Edit Pesanan" : "Tambah Pesanan";

  if (o) {
    const fields = {
      customer: o.customerId,
      service: o.service,
      weight: o.weight,
      price: o.price,
      status: o.status,
      payment: o.payment,
      date: o.date,
      note: o.note || ""
    };
    for (const [key, val] of Object.entries(fields)) {
      const el = document.getElementById("order-" + key);
      if (el) el.value = val;
    }
  } else {
    document.getElementById("order-date").value = today();
  }

  modal.classList.add("show");
}

function editOrder(id) {
  openOrderModal(id);
}

function closeOrderModal() {
  document.getElementById("order-modal")?.classList.remove("show");
}

function deleteOrder(id) {
  if (confirm("Yakin ingin menghapus pesanan ini?")) {
    db.orders = db.orders.filter(o => o.id !== id);
    save();
    renderAll();
    toast("Pesanan berhasil dihapus.");
  }
}

function submitOrder(e) {
  e.preventDefault();

  const id = Number(document.getElementById("order-id").value);
  const customerId = Number(document.getElementById("order-customer").value);
  const weight = Number(document.getElementById("order-weight").value);
  const price = Number(document.getElementById("order-price").value);
  const date = document.getElementById("order-date").value;

  if (!customerId) {
    toast("Tambahkan pelanggan terlebih dahulu.");
    return;
  }
  if (!Number.isFinite(weight) || !Number.isFinite(price) || weight <= 0 || price <= 0) {
    toast("Berat dan harga harus lebih dari 0.");
    return;
  }
  if (!date) {
    toast("Tanggal masuk wajib diisi.");
    return;
  }

  const item = {
    id: id || nextId(db.orders),
    customerId,
    service: document.getElementById("order-service").value,
    weight,
    price,
    status: document.getElementById("order-status").value,
    payment: document.getElementById("order-payment").value,
    date,
    note: document.getElementById("order-note").value.trim()
  };

  if (id) {
    db.orders = db.orders.map(o => (o.id === id ? item : o));
    toast("Pesanan berhasil diperbarui.");
  } else {
    db.orders.push(item);
    toast("Pesanan baru berhasil ditambahkan.");
  }

  save();
  closeOrderModal();
  renderAll();
}

/* ---------- Pelanggan ---------- */

function renderCustomers() {
  const tbody = document.getElementById("customers-body");
  if (!tbody) return;

  const q = (document.getElementById("customer-search")?.value || "").toLowerCase();
  const rows = db.customers.filter(c =>
    (c.name + " " + c.phone + " " + c.address).toLowerCase().includes(q)
  );

  tbody.innerHTML = rows.length
    ? rows
        .map(
          c =>
            `<tr><td><div class="customer-cell"><span class="mini-avatar">${esc(c.name.trim().charAt(0).toUpperCase() || "?")}</span><strong>${esc(c.name)}</strong></div></td><td>${esc(c.phone)}</td><td>${esc(c.address)}</td><td>${db.orders.filter(o => o.customerId === c.id).length} pesanan</td><td><div class="actions"><button class="icon-btn" onclick="editCustomer(${c.id})" title="Edit">✎</button><button class="icon-btn" onclick="deleteCustomer(${c.id})" title="Hapus">⌫</button></div></td></tr>`
        )
        .join("")
    : `<tr><td colspan="5" class="empty">Pelanggan tidak ditemukan.</td></tr>`;
}

function openCustomerModal(id = null) {
  const modal = document.getElementById("customer-modal");
  const form = document.getElementById("customer-form");

  form.reset();
  document.getElementById("customer-id").value = id || "";

  const c = db.customers.find(x => x.id === id);
  document.getElementById("customer-modal-title").textContent = c
    ? "Edit Pelanggan"
    : "Tambah Pelanggan";

  if (c) {
    document.getElementById("customer-name").value = c.name;
    document.getElementById("customer-phone").value = c.phone;
    document.getElementById("customer-address").value = c.address;
  }

  modal.classList.add("show");
}

function editCustomer(id) {
  openCustomerModal(id);
}

function closeCustomerModal() {
  document.getElementById("customer-modal")?.classList.remove("show");
}

function submitCustomer(e) {
  e.preventDefault();

  const id = Number(document.getElementById("customer-id").value);
  const name = document.getElementById("customer-name").value.trim();
  const phone = document.getElementById("customer-phone").value.trim();
  const address = document.getElementById("customer-address").value.trim();

  if (name.length < 2 || address.length < 3) {
    toast("Nama (min. 2 huruf) dan alamat (min. 3 karakter) wajib diisi.");
    return;
  }
  if (!/^(\+62|0)[0-9]{8,13}$/.test(phone)) {
    toast("Nomor telepon tidak valid. Gunakan 08xxxxxxxxxx atau +62xxxxxxxxxx.");
    return;
  }

  const c = { id: id || nextId(db.customers), name, phone, address };

  if (id) {
    db.customers = db.customers.map(x => (x.id === id ? c : x));
    toast("Data pelanggan diperbarui.");
  } else {
    db.customers.push(c);
    toast("Pelanggan berhasil ditambahkan.");
  }

  save();
  closeCustomerModal();
  renderAll();
}

function deleteCustomer(id) {
  if (db.orders.some(o => o.customerId === id)) {
    alert("Pelanggan masih memiliki pesanan. Hapus atau pindahkan pesanan terlebih dahulu.");
    return;
  }

  if (confirm("Yakin ingin menghapus pelanggan ini?")) {
    db.customers = db.customers.filter(c => c.id !== id);
    save();
    renderAll();
    toast("Pelanggan berhasil dihapus.");
  }
}

/* ---------- Laporan ---------- */

function renderReports() {
  const total = db.orders.reduce((s, o) => s + orderTotal(o), 0);
  const paid = db.orders
    .filter(o => o.payment === "Lunas")
    .reduce((s, o) => s + orderTotal(o), 0);
  const unpaid = total - paid;

  setText("report-total", money(total));
  setText("report-paid", money(paid));
  setText("report-unpaid", money(unpaid));
  setText("report-count", db.orders.length);

  const counts = ["Menunggu", "Diproses", "Selesai"].map(s => ({
    s,
    n: db.orders.filter(o => o.status === s).length
  }));
  const max = Math.max(1, ...counts.map(x => x.n));

  const el = document.getElementById("status-bars");
  if (el) {
    el.innerHTML = counts
      .map(
        x =>
          `<div><div class="bar-label"><span>${x.s}</span><strong>${x.n} pesanan</strong></div><div class="bar-track"><div class="bar-fill" style="width:${x.n / max * 100}%"></div></div></div>`
      )
      .join("");
  }

  const tbody = document.getElementById("report-body");
  if (tbody) {
    tbody.innerHTML = db.orders.length
      ? [...db.orders]
          .sort((a, b) => b.id - a.id)
          .map(
            o =>
              `<tr><td>#${o.id}</td><td>${esc(o.date)}</td><td>${esc(customerName(o.customerId))}</td><td>${esc(o.service)}</td><td>${money(orderTotal(o))}</td><td><span class="pay ${paymentClass(o.payment)}">${o.payment}</span></td></tr>`
          )
          .join("")
      : `<tr><td colspan="6" class="empty">Belum ada transaksi.</td></tr>`;
  }
}

/* ---------- Init ---------- */

document.addEventListener("DOMContentLoaded", () => {
  navSetup();
  renderDashboard();
  renderOrders();
  renderCustomers();
  renderReports();

  document.getElementById("order-search")?.addEventListener("input", renderOrders);
  document.getElementById("status-filter")?.addEventListener("change", renderOrders);
  document.getElementById("order-form")?.addEventListener("submit", submitOrder);
  document.getElementById("customer-search")?.addEventListener("input", renderCustomers);
  document.getElementById("customer-form")?.addEventListener("submit", submitCustomer);

  document.addEventListener("keydown", e => {
    if (e.key === "Escape") {
      closeOrderModal();
      closeCustomerModal();
      document.querySelector(".sidebar")?.classList.remove("open");
    }
  });

  [
    ["order-modal", closeOrderModal],
    ["customer-modal", closeCustomerModal]
  ].forEach(([id, fn]) =>
    document.getElementById(id)?.addEventListener("click", e => {
      if (e.target.id === id) fn();
    })
  );

  showView("dashboard");
});