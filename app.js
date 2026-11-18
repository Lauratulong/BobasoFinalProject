const STORAGE_KEY = "laundryku_data_v1";
const SESSION_KEY = "laundryku_session_v1";
const PROOF_FALLBACK_KEY = "laundryku_proofs_fallback_v1";
const IDB_NAME = "BobasoLaundryProofDB";
const IDB_STORE = "proofs";
const MAX_PROOF_BYTES = 2 * 1024 * 1024; // 2 MB
const ALLOWED_IMAGE_TYPES = ["image/jpeg", "image/jpg", "image/png", "image/webp"];
const ALLOWED_IMAGE_EXT = /\.(jpe?g|png|webp)$/i;
const DEFAULT_ADMIN_USERNAME = "admin";
const INITIAL_ADMIN_PASSWORD = "admin123";

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

const nowDateTime = () => {
  const d = new Date();
  const datePart = today();
  const timePart = d.toTimeString().slice(0, 5);
  return `${datePart} ${timePart}`;
};

const esc = s =>
  String(s ?? "").replace(/[&<>"']/g, c => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;"
  }[c]));

const seed = {
  customers: [],
  orders: [],
  accounts: [
    {
      id: 1,
      customerId: null,
      username: DEFAULT_ADMIN_USERNAME,
      password: INITIAL_ADMIN_PASSWORD,
      role: "admin",
      updatedAt: ""
    }
  ],
  payments: []
};

/* ---------- IndexedDB untuk Penyimpanan Gambar Bukti Pembayaran ---------- */

function openProofDB() {
  return new Promise((resolve, reject) => {
    if (typeof indexedDB === "undefined") {
      reject(new Error("IndexedDB tidak tersedia"));
      return;
    }
    const req = indexedDB.open(IDB_NAME, 1);
    req.onupgradeneeded = e => {
      const idb = e.target.result;
      if (!idb.objectStoreNames.contains(IDB_STORE)) {
        idb.createObjectStore(IDB_STORE, { keyPath: "id" });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function saveProofImage(proofId, dataUrl) {
  try {
    const idb = await openProofDB();
    await new Promise((resolve, reject) => {
      const tx = idb.transaction(IDB_STORE, "readwrite");
      tx.objectStore(IDB_STORE).put({ id: proofId, dataUrl, savedAt: Date.now() });
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
    idb.close();
    return true;
  } catch (err) {
    try {
      const raw = localStorage.getItem(PROOF_FALLBACK_KEY);
      const map = raw ? JSON.parse(raw) : {};
      map[proofId] = dataUrl;
      localStorage.setItem(PROOF_FALLBACK_KEY, JSON.stringify(map));
      return true;
    } catch (storageErr) {
      toast("Penyimpanan penuh. Gunakan gambar dengan ukuran lebih kecil.");
      return false;
    }
  }
}

async function getProofImage(proofId) {
  if (!proofId) return null;
  try {
    const idb = await openProofDB();
    const record = await new Promise((resolve, reject) => {
      const tx = idb.transaction(IDB_STORE, "readonly");
      const req = tx.objectStore(IDB_STORE).get(proofId);
      req.onsuccess = () => resolve(req.result || null);
      req.onerror = () => reject(req.error);
    });
    idb.close();
    if (record?.dataUrl) return record.dataUrl;
  } catch (err) {
    // Abaikan dan cek fallback
  }
  try {
    const raw = localStorage.getItem(PROOF_FALLBACK_KEY);
    const map = raw ? JSON.parse(raw) : {};
    return map[proofId] || null;
  } catch (e) {
    return null;
  }
}

function compressImageToDataURL(file, maxDim = 1100, quality = 0.82) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error("Gagal membaca file gambar."));
    reader.onload = () => {
      const img = new Image();
      img.onerror = () => reject(new Error("File bukan gambar yang valid."));
      img.onload = () => {
        let { width, height } = img;
        if (width > maxDim || height > maxDim) {
          if (width >= height) {
            height = Math.round((height * maxDim) / width);
            width = maxDim;
          } else {
            width = Math.round((width * maxDim) / height);
            height = maxDim;
          }
        }
        const canvas = document.createElement("canvas");
        canvas.width = width;
        canvas.height = height;
        const ctx = canvas.getContext("2d");
        ctx.drawImage(img, 0, 0, width, height);
        const outType = file.type === "image/png" ? "image/png" : "image/jpeg";
        resolve(canvas.toDataURL(outType, quality));
      };
      img.src = reader.result;
    };
    reader.readAsDataURL(file);
  });
}

/* ---------- Tahapan Tracking Laundry ---------- */

const TRACKING_STAGES = [
  {
    key: "Menunggu",
    title: "Menunggu",
    desc: "Pesanan diterima & masuk antrean"
  },
  {
    key: "Diproses",
    title: "Diproses / Dicuci",
    desc: "Pakaian sedang dalam proses pencucian"
  },
  {
    key: "Sedang Dikeringkan",
    title: "Sedang Dikeringkan",
    desc: "Proses pengeringan pakaian"
  },
  {
    key: "Sedang Disetrika",
    title: "Sedang Disetrika",
    desc: "Disetrika & dirapikan dengan pewangi"
  },
  {
    key: "Siap Diambil",
    title: "Siap Diambil",
    desc: "Dikemas rapi & siap diambil pelanggan"
  },
  {
    key: "Selesai",
    title: "Selesai",
    desc: "Laundry telah selesai & diserahkan"
  }
];

function getStageIndex(status) {
  if (status === "Sedang Dicuci") return 1;
  const idx = TRACKING_STAGES.findIndex(s => s.key === status);
  return idx === -1 ? 0 : idx;
}

function isProcessingStatus(status) {
  return status !== "Menunggu" && status !== "Selesai";
}

function formatOrderCode(id) {
  return `#${id} (BL-${String(id).padStart(4, "0")})`;
}

function formatCustomerCode(id) {
  return `CUS-${String(id).padStart(3, "0")}`;
}

function estimateCompletionDate(order) {
  if (!order || !order.date) return "-";
  const base = new Date(order.date + "T00:00:00");
  if (Number.isNaN(base.getTime())) return order.date;
  const daysToAdd = order.service === "Laundry Express" ? 1 : 2;
  base.setDate(base.getDate() + daysToAdd);
  const yyyy = base.getFullYear();
  const mm = String(base.getMonth() + 1).padStart(2, "0");
  const dd = String(base.getDate()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd} (${daysToAdd} hari kerja)`;
}

/* ---------- Data & Migrasi Local Storage ---------- */

function cloneSeed() {
  return {
    customers: seed.customers.map(c => ({ ...c })),
    orders: seed.orders.map(o => ({ ...o })),
    accounts: seed.accounts.map(a => ({ ...a })),
    payments: seed.payments.map(p => ({ ...p }))
  };
}

function normalizePaymentStatus(order) {
  const valid = ["Belum Lunas", "Menunggu Verifikasi", "Lunas", "Ditolak"];
  if (valid.includes(order.paymentStatus)) return order.paymentStatus;
  if (valid.includes(order.payment)) return order.payment;
  return "Belum Lunas";
}

function migrateData(parsed) {
  const customers = Array.isArray(parsed.customers) ? parsed.customers : [];
  const orders = Array.isArray(parsed.orders)
    ? parsed.orders.map(o => {
        const payStat = normalizePaymentStatus(o);
        return {
          ...o,
          payment: payStat,
          paymentStatus: payStat,
          paymentMethod: o.paymentMethod || "",
          paymentProofId: o.paymentProofId || "",
          paymentProofName: o.paymentProofName || "",
          paymentProofDate: o.paymentProofDate || "",
          paymentNote: o.paymentNote || "",
          verifiedAt: o.verifiedAt || o.paidAt || "",
          paidAt: o.paidAt || o.verifiedAt || ""
        };
      })
    : [];

  const rawAccounts = Array.isArray(parsed.accounts) ? parsed.accounts : [];
  const accounts = [];

  // 1. Pastikan akun Admin selalu ada dan TIDAK menimpa password Admin yang sudah pernah diubah
  const existingAdmin = rawAccounts.find(a => a && a.role === "admin");
  if (existingAdmin && existingAdmin.password) {
    accounts.push({
      id: existingAdmin.id || 1,
      customerId: null,
      username: existingAdmin.username || DEFAULT_ADMIN_USERNAME,
      password: existingAdmin.password,
      role: "admin",
      updatedAt: existingAdmin.updatedAt || ""
    });
  } else {
    accounts.push({
      id: 1,
      customerId: null,
      username: DEFAULT_ADMIN_USERNAME,
      password: INITIAL_ADMIN_PASSWORD,
      role: "admin",
      updatedAt: ""
    });
  }

  // 2. Migrasi akun Customer secara aman: pastikan customerId valid dan tidak menghubungkan nama ganda yang ambigu
  const usedCustomerIds = new Set();
  rawAccounts
    .filter(a => a && a.role === "customer")
    .forEach(acc => {
      let validCustomerId = null;

      if (
        acc.customerId !== null &&
        acc.customerId !== undefined &&
        acc.customerId !== "" &&
        customers.some(c => String(c.id) === String(acc.customerId)) &&
        !usedCustomerIds.has(String(acc.customerId))
      ) {
        validCustomerId = acc.customerId;
      } else if (acc.phone) {
        // Cocokkan berdasarkan nomor telepon unik jika tersedia
        const cleanAccPhone = String(acc.phone).replace(/\s|-/g, "");
        const phoneMatches = customers.filter(
          c =>
            String(c.phone || "").replace(/\s|-/g, "") === cleanAccPhone &&
            !usedCustomerIds.has(String(c.id))
        );
        if (phoneMatches.length === 1) {
          validCustomerId = phoneMatches[0].id;
        }
      }

      if (validCustomerId !== null) {
        usedCustomerIds.add(String(validCustomerId));
      }

      accounts.push({
        id: acc.id || accounts.length + 1,
        customerId: validCustomerId,
        username: acc.username,
        password: acc.password,
        role: "customer",
        updatedAt: acc.updatedAt || ""
      });
    });

  const payments = Array.isArray(parsed.payments) ? parsed.payments : [];
  return { customers, orders, accounts, payments };
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
      return migrateData(parsed);
    }
    return cloneSeed();
  } catch (e) {
    return cloneSeed();
  }
}

let db = loadData();
let currentSession = loadSession();
let selectedCustomerOrderId = null;
let matchedCustomerOrders = [];
let pendingProofFile = null;
let pendingProofDataUrl = null;
let activeAdminProofOrderId = null;

function save() {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(db));
}

function saveAccountChanges() {
  save();
}

function renderAll() {
  renderDashboard();
  renderOrders();
  renderCustomers();
  renderReports();
  renderAdminSettingsInfo();
  renderCustomerWelcomeAndStats();
  renderCustomerQuickChips();
  renderCustomerHistory();
  if (selectedCustomerOrderId) {
    const myOrders = filterOrdersByCustomerId(getCurrentCustomerId());
    const stillAccessible = myOrders.some(
      o => String(o.id) === String(selectedCustomerOrderId)
    );
    if (stillAccessible) {
      renderCustomerOrderDetail(selectedCustomerOrderId);
    } else {
      selectedCustomerOrderId = null;
      const orderView = document.getElementById("customer-order-view");
      if (orderView) orderView.hidden = true;
    }
  }
}

/* ---------- Fungsi Khusus Akun, CustomerId, Filter & Validasi Akses ---------- */

// 1. Mengambil akun yang sedang login langsung dari db.accounts
function getLoggedInAccount() {
  if (!currentSession) return null;

  if (currentSession.role === "admin") {
    return (
      db.accounts.find(
        a =>
          a.role === "admin" &&
          String(a.username).toLowerCase() ===
            String(currentSession.username || DEFAULT_ADMIN_USERNAME).toLowerCase()
      ) || null
    );
  }

  if (currentSession.role === "customer") {
    return (
      db.accounts.find(
        a =>
          a.role === "customer" &&
          (String(a.id) === String(currentSession.accountId) ||
            String(a.username).toLowerCase() ===
              String(currentSession.username || "").toLowerCase())
      ) || null
    );
  }

  return null;
}

// 2. Mengambil customerId pengguna yang sedang login dari data akun resmi
function getCurrentCustomerId() {
  const account = getLoggedInAccount();
  if (!account || account.role !== "customer") return null;
  if (
    account.customerId === null ||
    account.customerId === undefined ||
    account.customerId === ""
  ) {
    return null;
  }
  const customerExists = db.customers.some(
    c => String(c.id) === String(account.customerId)
  );
  return customerExists ? account.customerId : null;
}

// 3. Memfilter pesanan secara ketat berdasarkan customerId
function filterOrdersByCustomerId(customerId, ordersList = db.orders) {
  if (customerId === null || customerId === undefined || customerId === "") {
    return [];
  }
  if (!Array.isArray(ordersList)) return [];
  return ordersList.filter(
    order => String(order.customerId) === String(customerId)
  );
}

// 4. Memvalidasi akses Customer (termasuk pemeriksaan kepemilikan pesanan/customerId)
function validateCustomerAccess(targetOrderOrCustomerId = null) {
  const account = getLoggedInAccount();
  if (!currentSession || currentSession.role !== "customer" || !account) {
    toast("Akses ditolak: Silakan login sebagai Customer.");
    return false;
  }

  const myCustomerId = getCurrentCustomerId();
  if (myCustomerId === null) {
    return false;
  }

  if (targetOrderOrCustomerId !== null && targetOrderOrCustomerId !== undefined) {
    if (typeof targetOrderOrCustomerId === "object") {
      return String(targetOrderOrCustomerId.customerId) === String(myCustomerId);
    }
    return String(targetOrderOrCustomerId) === String(myCustomerId);
  }

  return true;
}

// 5. Memvalidasi akses Admin
function validateAdminAccess() {
  const account = getLoggedInAccount();
  if (!currentSession || currentSession.role !== "admin" || !account) {
    toast("Akses ditolak: Fitur ini hanya untuk Admin.");
    return false;
  }
  return true;
}

function requireAdmin() {
  return validateAdminAccess();
}

// 6. Mengubah password Admin dengan validasi penuh
function changeAdminPassword(currentPassword, newPassword, confirmPassword) {
  if (!validateAdminAccess()) {
    return { ok: false, message: "Akses ditolak: Hanya Admin yang dapat mengubah password Admin." };
  }

  if (!currentPassword || !newPassword || !confirmPassword) {
    return { ok: false, message: "Semua kolom password wajib diisi." };
  }

  const adminAccount = db.accounts.find(a => a.role === "admin");
  if (!adminAccount) {
    return { ok: false, message: "Akun Admin tidak ditemukan." };
  }

  if (currentPassword !== adminAccount.password) {
    return { ok: false, message: "Current Password tidak sesuai dengan password Admin saat ini." };
  }

  if (newPassword.length < 8) {
    return { ok: false, message: "New Password minimal harus 8 karakter." };
  }

  if (newPassword === currentPassword) {
    return { ok: false, message: "New Password harus berbeda dari Current Password." };
  }

  if (confirmPassword !== newPassword) {
    return { ok: false, message: "Confirm New Password harus sama dengan New Password." };
  }

  adminAccount.password = newPassword;
  adminAccount.updatedAt = nowDateTime();
  saveAccountChanges();
  renderAdminSettingsInfo();

  return { ok: true, message: "Password successfully updated" };
}

function handleChangeAdminPassword(e) {
  e.preventDefault();
  const currentPassword = document.getElementById("admin-current-password")?.value || "";
  const newPassword = document.getElementById("admin-new-password")?.value || "";
  const confirmPassword = document.getElementById("admin-confirm-password")?.value || "";
  const errEl = document.getElementById("admin-password-error");

  const result = changeAdminPassword(currentPassword, newPassword, confirmPassword);
  if (!result.ok) {
    if (errEl) {
      errEl.textContent = result.message;
      errEl.hidden = false;
    }
    toast(result.message);
    return;
  }

  if (errEl) errEl.hidden = true;
  document.getElementById("admin-password-form")?.reset();
  toast(result.message);
}

function clearAdminPasswordError() {
  const errEl = document.getElementById("admin-password-error");
  if (errEl) errEl.hidden = true;
}

function renderAdminSettingsInfo() {
  const adminAccount = db.accounts.find(a => a.role === "admin");
  if (!adminAccount) return;
  setText("settings-admin-username", adminAccount.username || DEFAULT_ADMIN_USERNAME);
  setText(
    "settings-password-updated",
    adminAccount.updatedAt ? adminAccount.updatedAt : "Default / Belum Diubah"
  );
}

/* ---------- Sesi, Login & Create Account ---------- */

function loadSession() {
  try {
    const raw = localStorage.getItem(SESSION_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (parsed && (parsed.role === "admin" || parsed.role === "customer")) {
      return parsed;
    }
    return null;
  } catch (e) {
    return null;
  }
}

function saveSession(session) {
  currentSession = session;
  if (session) {
    localStorage.setItem(SESSION_KEY, JSON.stringify(session));
  } else {
    localStorage.removeItem(SESSION_KEY);
  }
}

function toggleAuthMode(mode) {
  const loginCard = document.getElementById("login-card-box");
  const registerCard = document.getElementById("register-card-box");
  const loginErr = document.getElementById("login-error");
  const regErr = document.getElementById("register-error");

  if (loginErr) loginErr.hidden = true;
  if (regErr) regErr.hidden = true;

  if (mode === "register") {
    if (loginCard) loginCard.hidden = true;
    if (registerCard) registerCard.hidden = false;
  } else {
    if (registerCard) registerCard.hidden = true;
    if (loginCard) loginCard.hidden = false;
  }
}

function selectLoginRole(role) {
  const roleInput = document.getElementById("login-role");
  if (roleInput) roleInput.value = role;

  document.querySelectorAll(".role-tab").forEach(btn => {
    btn.classList.toggle("active", btn.dataset.role === role);
  });

  const errEl = document.getElementById("login-error");
  if (errEl) errEl.hidden = true;
}

function handleRegister(e) {
  e.preventDefault();

  const fullName = (document.getElementById("reg-name")?.value || "").trim();
  const phone = (document.getElementById("reg-phone")?.value || "").trim();
  const address = (document.getElementById("reg-address")?.value || "").trim();
  const username = (document.getElementById("reg-username")?.value || "").trim();
  const password = document.getElementById("reg-password")?.value || "";
  const confirmPassword = document.getElementById("reg-confirm-password")?.value || "";
  const errEl = document.getElementById("register-error");

  const showRegError = msg => {
    if (errEl) {
      errEl.textContent = msg;
      errEl.hidden = false;
    }
    toast(msg);
  };

  if (!fullName || !phone || !address || !username || !password || !confirmPassword) {
    showRegError("Semua kolom registrasi wajib diisi.");
    return;
  }
  if (fullName.length < 2) {
    showRegError("Nama lengkap minimal 2 karakter.");
    return;
  }
  if (!/^(\+62|0)[0-9]{8,13}$/.test(phone)) {
    showRegError("Nomor telepon tidak valid. Gunakan format 08xxxxxxxxxx atau +62xxxxxxxxxx.");
    return;
  }
  if (address.length < 3) {
    showRegError("Alamat minimal 3 karakter.");
    return;
  }
  if (username.length < 4 || /\s/.test(username)) {
    showRegError("Username minimal 4 karakter dan tidak boleh mengandung spasi.");
    return;
  }

  const uLower = username.toLowerCase();
  const usernameTaken =
    uLower === DEFAULT_ADMIN_USERNAME ||
    db.accounts.some(a => String(a.username || "").toLowerCase() === uLower);

  if (usernameTaken) {
    showRegError("Username sudah terdaftar. Silakan pilih username lain.");
    return;
  }
  if (password.length < 8) {
    showRegError("Password minimal 8 karakter.");
    return;
  }
  if (password !== confirmPassword) {
    showRegError("Confirm Password harus sama dengan Password.");
    return;
  }

  // Hubungkan dengan data pelanggan berdasarkan nomor telepon unik agar tidak terjadi duplikasi
  const cleanPhone = phone.replace(/\s|-/g, "");
  const existingCustomer = db.customers.find(
    c => String(c.phone || "").replace(/\s|-/g, "") === cleanPhone
  );

  let customerId;
  if (existingCustomer) {
    const alreadyLinked = db.accounts.some(
      a =>
        a.role === "customer" &&
        String(a.customerId) === String(existingCustomer.id)
    );
    if (alreadyLinked) {
      showRegError("Nomor telepon pelanggan ini sudah terhubung dengan akun lain.");
      return;
    }
    existingCustomer.name = fullName;
    existingCustomer.phone = phone;
    existingCustomer.address = address;
    customerId = existingCustomer.id;
  } else {
    customerId = nextId(db.customers);
    db.customers.push({
      id: customerId,
      name: fullName,
      phone,
      address
    });
  }

  const newAccount = {
    id: nextId(db.accounts),
    customerId,
    username,
    password,
    role: "customer",
    updatedAt: nowDateTime()
  };
  db.accounts.push(newAccount);

  saveAccountChanges();
  renderAll();

  document.getElementById("register-form")?.reset();
  if (errEl) errEl.hidden = true;

  toggleAuthMode("login");
  selectLoginRole("customer");
  const loginUserEl = document.getElementById("login-username");
  const loginPassEl = document.getElementById("login-password");
  if (loginUserEl) loginUserEl.value = username;
  if (loginPassEl) loginPassEl.value = "";

  toast("Registrasi akun Customer berhasil! Silakan login.");
}

function handleLogin(e) {
  e.preventDefault();
  const role = document.getElementById("login-role")?.value || "admin";
  const username = (document.getElementById("login-username")?.value || "").trim();
  const password = document.getElementById("login-password")?.value || "";
  const errEl = document.getElementById("login-error");

  const showError = msg => {
    if (errEl) {
      errEl.textContent = msg;
      errEl.hidden = false;
    }
    toast(msg);
  };

  if (!username || !password) {
    showError("Username dan password wajib diisi.");
    return;
  }

  // Login Admin: Membaca akun Admin dari db.accounts di Local Storage
  if (role === "admin") {
    const adminAccount = db.accounts.find(
      a =>
        a.role === "admin" &&
        String(a.username || "").toLowerCase() === username.toLowerCase()
    );

    if (adminAccount && adminAccount.password === password) {
      saveSession({
        role: "admin",
        accountId: adminAccount.id,
        username: adminAccount.username,
        displayName: "Admin Laundry"
      });
      if (errEl) errEl.hidden = true;
      applySessionUI();
      showView("dashboard");
      toast("Berhasil masuk sebagai Admin.");
    } else {
      showError("Username atau password Admin tidak valid.");
    }
    return;
  }

  // Login Customer: Wajib menggunakan akun Customer terdaftar yang memiliki customerId valid
  const account = db.accounts.find(
    a =>
      a.role === "customer" &&
      String(a.username || "").toLowerCase() === username.toLowerCase() &&
      a.password === password
  );

  if (!account) {
    showError("Username atau password Customer tidak valid. Silakan buat akun melalui Create Account.");
    return;
  }

  const linkedCustomer = customerById(account.customerId);
  const displayName = linkedCustomer ? linkedCustomer.name : account.username;

  // Reset state pencarian pelanggan sebelumnya sebelum memuat akun baru
  selectedCustomerOrderId = null;
  matchedCustomerOrders = [];
  clearSelectedProofFile();

  saveSession({
    role: "customer",
    accountId: account.id,
    customerId: linkedCustomer ? linkedCustomer.id : null,
    username: account.username,
    displayName
  });

  if (errEl) errEl.hidden = true;
  applySessionUI();
  showView("customer-dashboard");
  loadLoggedCustomerOrders();
  toast(`Welcome back, ${displayName}!`);
}

function handleLogout() {
  saveSession(null);
  selectedCustomerOrderId = null;
  matchedCustomerOrders = [];
  clearSelectedProofFile();
  closeOrderModal();
  closeCustomerModal();
  closeProofModal();
  closeReceiptModal();
  resetCustomerSearch(true);

  document.getElementById("login-form")?.reset();
  document.getElementById("register-form")?.reset();
  document.getElementById("admin-password-form")?.reset();
  toggleAuthMode("login");
  selectLoginRole("admin");

  applySessionUI();
  toast("Anda telah keluar dari sesi.");
}

function applySessionUI() {
  const loginScreen = document.getElementById("login-screen");
  const appShell = document.getElementById("app-shell");
  const adminNav = document.getElementById("admin-nav");
  const customerNav = document.getElementById("customer-nav");
  const roleBadge = document.getElementById("active-role-badge");
  const userAvatar = document.getElementById("active-user-avatar");
  const userName = document.getElementById("active-user-name");
  const sidebarSubtitle = document.getElementById("sidebar-subtitle");
  const topEyebrow = document.getElementById("top-eyebrow");
  const sidebarNoteText = document.getElementById("sidebar-note-text");

  const activeAccount = getLoggedInAccount();
  if (!currentSession || !activeAccount) {
    if (currentSession && !activeAccount) {
      saveSession(null);
    }
    if (loginScreen) loginScreen.hidden = false;
    if (appShell) appShell.hidden = true;
    return;
  }

  if (loginScreen) loginScreen.hidden = true;
  if (appShell) appShell.hidden = false;

  const isAdmin = activeAccount.role === "admin";
  if (adminNav) adminNav.hidden = !isAdmin;
  if (customerNav) customerNav.hidden = isAdmin;

  const myCustomer = !isAdmin ? customerById(getCurrentCustomerId()) : null;
  const displayTitle = isAdmin
    ? "Admin Laundry"
    : myCustomer
      ? myCustomer.name
      : activeAccount.username;

  if (roleBadge) {
    roleBadge.textContent = isAdmin ? "ADMIN" : "CUSTOMER";
    roleBadge.classList.toggle("customer", !isAdmin);
  }
  if (userAvatar) {
    userAvatar.textContent = (displayTitle || "U").trim().charAt(0).toUpperCase();
  }
  if (userName) {
    userName.textContent = displayTitle;
  }
  if (sidebarSubtitle) {
    sidebarSubtitle.textContent = isAdmin ? "Management System" : "Customer Portal";
  }
  if (topEyebrow) {
    topEyebrow.textContent = isAdmin
      ? "LAUNDRY MANAGEMENT SYSTEM"
      : "CUSTOMER TRACKING & PAYMENT PORTAL";
  }
  if (sidebarNoteText) {
    sidebarNoteText.textContent = isAdmin
      ? "Perbarui status pesanan dan verifikasi bukti pembayaran secara berkala."
      : "Anda hanya melihat pesanan dan riwayat pembayaran yang terhubung dengan akun Anda.";
  }

  renderCustomerWelcomeAndStats();
}

/* ---------- Helpers ---------- */

function nextId(list) {
  return list.length ? Math.max(...list.map(x => Number(x.id) || 0)) + 1 : 1;
}

function customerById(id) {
  if (id === null || id === undefined || id === "") return null;
  return db.customers.find(c => String(c.id) === String(id)) || null;
}

function customerName(id) {
  return customerById(id)?.name || "Pelanggan dihapus";
}

function customerPhone(id) {
  return customerById(id)?.phone || "-";
}

function orderTotal(o) {
  return Math.round(Number(o.weight) * Number(o.price));
}

function getOrderPaymentStatus(o) {
  return o.paymentStatus || o.payment || "Belum Lunas";
}

let toastTimer = null;

function toast(message) {
  const el = document.getElementById("toast");
  if (!el) return;
  el.textContent = message;
  el.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove("show"), 2800);
}

function statusClass(s) {
  if (s === "Selesai") return "status-selesai";
  if (s === "Siap Diambil") return "status-siap";
  if (s === "Menunggu") return "status-menunggu";
  return "status-diproses";
}

function paymentClass(s) {
  if (s === "Lunas") return "pay-lunas";
  if (s === "Menunggu Verifikasi") return "pay-verifikasi";
  if (s === "Ditolak") return "pay-ditolak";
  return "pay-belum";
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
  if (!validateAdminAccess()) return;
  if (!db.orders.length) {
    toast("Belum ada data pesanan untuk diekspor.");
    return;
  }
  const headers = [
    "ID Pesanan",
    "Customer ID",
    "Tanggal",
    "Pelanggan",
    "Layanan",
    "Berat (kg)",
    "Harga/kg (Rp)",
    "Total (Rp)",
    "Status Cucian",
    "Status Pembayaran",
    "Metode Pembayaran",
    "Tanggal Upload Bukti",
    "Tanggal Verifikasi",
    "Catatan"
  ];
  const rows = [...db.orders]
    .sort((a, b) => a.id - b.id)
    .map(o => [
      o.id,
      formatCustomerCode(o.customerId),
      o.date,
      customerName(o.customerId),
      o.service,
      o.weight,
      o.price,
      orderTotal(o),
      o.status,
      getOrderPaymentStatus(o),
      o.paymentMethod || "-",
      o.paymentProofDate || "-",
      o.verifiedAt || "-",
      o.note || ""
    ]);
  downloadCSV(`pesanan-laundry-${today()}.csv`, headers, rows);
  toast("Data pesanan berhasil diekspor ke CSV.");
}

function exportCustomersCSV() {
  if (!validateAdminAccess()) return;
  if (!db.customers.length) {
    toast("Belum ada data pelanggan untuk diekspor.");
    return;
  }
  const headers = [
    "Customer ID",
    "Nama Pelanggan",
    "Nomor Telepon",
    "Alamat",
    "Username Akun",
    "Jumlah Pesanan"
  ];
  const rows = [...db.customers]
    .sort((a, b) => a.id - b.id)
    .map(c => {
      const acc = db.accounts.find(
        a => a.role === "customer" && String(a.customerId) === String(c.id)
      );
      return [
        formatCustomerCode(c.id),
        c.name,
        c.phone,
        c.address,
        acc ? acc.username : "-",
        filterOrdersByCustomerId(c.id).length
      ];
    });
  downloadCSV(`pelanggan-laundry-${today()}.csv`, headers, rows);
  toast("Data pelanggan berhasil diekspor ke CSV.");
}

/* ---------- Navigasi ---------- */

const ADMIN_VIEWS = ["dashboard", "orders", "customers", "reports", "settings"];
const CUSTOMER_VIEWS = ["customer-dashboard", "customer-history"];

function showView(page) {
  const account = getLoggedInAccount();
  if (!currentSession || !account) {
    applySessionUI();
    return;
  }

  if (account.role === "customer" && ADMIN_VIEWS.includes(page)) {
    toast("Akses ditolak: Halaman khusus Admin.");
    page = "customer-dashboard";
  } else if (account.role === "admin" && CUSTOMER_VIEWS.includes(page)) {
    page = "dashboard";
  }

  document.querySelectorAll(".view").forEach(v => (v.hidden = v.dataset.view !== page));
  document
    .querySelectorAll(".nav-list a")
    .forEach(a => a.classList.toggle("active", a.dataset.page === page));

  const titles = {
    dashboard: "Dashboard",
    orders: "Manajemen Pesanan",
    customers: "Data Pelanggan",
    reports: "Laporan",
    settings: "Pengaturan Admin",
    "customer-dashboard": "Pesanan Saya",
    "customer-history": "Riwayat Pembayaran Saya"
  };
  setText("top-title", titles[page] || "Dashboard");
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

/* ---------- Admin: Dashboard ---------- */

function renderDashboard() {
  const total = db.orders.length;
  const processing = db.orders.filter(o => isProcessingStatus(o.status)).length;
  const done = db.orders.filter(o => o.status === "Selesai").length;
  const revenue = db.orders
    .filter(o => getOrderPaymentStatus(o) === "Lunas")
    .reduce((s, o) => s + orderTotal(o), 0);
  const pendingVerify = db.orders.filter(
    o => getOrderPaymentStatus(o) === "Menunggu Verifikasi"
  ).length;

  setText("stat-orders", total);
  setText("stat-process", processing);
  setText("stat-done", done);
  setText("stat-revenue", money(revenue));
  setText(
    "stat-pending-verify",
    pendingVerify > 0
      ? `${pendingVerify} bukti menunggu verifikasi`
      : "Dari transaksi yang lunas"
  );

  const tbody = document.getElementById("recent-orders");
  if (tbody) {
    const rows = [...db.orders].sort((a, b) => b.id - a.id).slice(0, 5);
    tbody.innerHTML = rows.length
      ? rows
          .map(o => {
            const pStat = getOrderPaymentStatus(o);
            return `<tr>
              <td><strong>#${o.id}</strong></td>
              <td>${esc(customerName(o.customerId))}</td>
              <td>${esc(o.service)}</td>
              <td><span class="status ${statusClass(o.status)}">${esc(o.status)}</span></td>
              <td><span class="pay ${paymentClass(pStat)}">${esc(pStat)}</span></td>
              <td>${money(orderTotal(o))}</td>
            </tr>`;
          })
          .join("")
      : `<tr><td colspan="6" class="empty">
          <div class="empty-laundry-state">
            <span class="empty-laundry-icon">🧺</span>
            <strong>Belum ada pesanan laundry</strong>
            <small>Klik tombol "+ Buat Pesanan Baru" untuk mencatat pesanan pertama.</small>
          </div>
        </td></tr>`;
  }
}

/* ---------- Admin: Pesanan & Verifikasi Pembayaran ---------- */

function renderOrders() {
  const tbody = document.getElementById("orders-body");
  if (!tbody) return;

  const q = (document.getElementById("order-search")?.value || "").toLowerCase();
  const status = document.getElementById("status-filter")?.value || "";
  const payFilter = document.getElementById("payment-filter")?.value || "";

  const rows = [...db.orders]
    .sort((a, b) => b.id - a.id)
    .filter(o => {
      const pStat = getOrderPaymentStatus(o);
      const matchQuery =
        String(o.id).includes(q) ||
        formatOrderCode(o.id).toLowerCase().includes(q) ||
        formatCustomerCode(o.customerId).toLowerCase().includes(q) ||
        customerName(o.customerId).toLowerCase().includes(q) ||
        o.service.toLowerCase().includes(q);
      const matchStatus = !status || o.status === status;
      const matchPay = !payFilter || pStat === payFilter;
      return matchQuery && matchStatus && matchPay;
    });

  tbody.innerHTML = rows.length
    ? rows
        .map(o => {
          const pStat = getOrderPaymentStatus(o);
          const hasProof = Boolean(o.paymentProofId);
          const proofBtnLabel = hasProof
            ? "🧾 View Payment Proof"
            : "View Payment Proof";
          return `<tr>
            <td><strong>#${o.id}</strong></td>
            <td><div class="customer-cell"><span class="mini-avatar">${esc(
              customerName(o.customerId).trim().charAt(0).toUpperCase() || "?"
            )}</span><div><strong>${esc(customerName(o.customerId))}</strong><br><small class="muted">${esc(formatCustomerCode(o.customerId))}</small></div></div></td>
            <td>${esc(o.service)}</td>
            <td>${o.weight} kg</td>
            <td><strong>${money(orderTotal(o))}</strong></td>
            <td><span class="status ${statusClass(o.status)}">${esc(o.status)}</span></td>
            <td><span class="pay ${paymentClass(pStat)}">${esc(pStat)}</span></td>
            <td>
              <button type="button" class="btn ${hasProof ? "btn-primary" : "btn-light"} btn-sm" onclick="openProofModal(${o.id})">
                ${proofBtnLabel}
              </button>
            </td>
            <td>
              <div class="actions">
                <button type="button" class="btn btn-success btn-sm" title="Verifikasi Lunas" onclick="quickVerifyOrder(${o.id})">✓ Verify</button>
                <button type="button" class="btn btn-danger btn-sm" title="Tolak Bukti Pembayaran" onclick="openProofModal(${o.id}, true)">✕ Reject</button>
              </div>
            </td>
            <td>
              <div class="actions">
                <button class="icon-btn" title="Edit" onclick="editOrder(${o.id})">✎</button>
                <button class="icon-btn" title="Hapus" onclick="deleteOrder(${o.id})">⌫</button>
              </div>
            </td>
          </tr>`;
        })
        .join("")
    : `<tr><td colspan="10" class="empty">
        <div class="empty-laundry-state">
          <span class="empty-laundry-icon">🫧</span>
          <strong>Data pesanan tidak ditemukan</strong>
          <small>Ubah kata kunci pencarian atau tambahkan pesanan baru.</small>
        </div>
      </td></tr>`;
}

function openOrderModal(id = null) {
  if (!validateAdminAccess()) return;

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
    .map(
      c =>
        `<option value="${c.id}">${esc(formatCustomerCode(c.id))} · ${esc(c.name)} (${esc(c.phone)})</option>`
    )
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
      payment: getOrderPaymentStatus(o),
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
  if (!validateAdminAccess()) return;
  openOrderModal(id);
}

function closeOrderModal() {
  document.getElementById("order-modal")?.classList.remove("show");
}

function deleteOrder(id) {
  if (!validateAdminAccess()) return;
  if (confirm("Yakin ingin menghapus pesanan ini?")) {
    db.orders = db.orders.filter(o => o.id !== id);
    save();
    renderAll();
    toast("Pesanan berhasil dihapus.");
  }
}

function submitOrder(e) {
  e.preventDefault();
  if (!validateAdminAccess()) return;

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

  const existing = id ? db.orders.find(o => o.id === id) : null;
  const newPayment = document.getElementById("order-payment").value;
  const nowStr = nowDateTime();

  const item = {
    id: id || nextId(db.orders),
    customerId,
    service: document.getElementById("order-service").value,
    weight,
    price,
    status: document.getElementById("order-status").value,
    payment: newPayment,
    paymentStatus: newPayment,
    date,
    note: document.getElementById("order-note").value.trim(),
    paymentMethod:
      existing?.paymentMethod ||
      (newPayment === "Lunas" ? "Verifikasi Admin" : ""),
    paymentProofId: existing?.paymentProofId || "",
    paymentProofName: existing?.paymentProofName || "",
    paymentProofDate: existing?.paymentProofDate || "",
    paymentNote: existing?.paymentNote || "",
    verifiedAt:
      newPayment === "Lunas"
        ? existing?.verifiedAt || nowStr
        : existing?.verifiedAt || "",
    paidAt:
      newPayment === "Lunas"
        ? existing?.paidAt || nowStr
        : existing?.paidAt || ""
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

/* ---------- Admin: Modal View & Verify Payment Proof ---------- */

async function openProofModal(orderId, openRejectBox = false) {
  if (!validateAdminAccess()) return;

  const o = db.orders.find(x => x.id === Number(orderId));
  if (!o) return;

  activeAdminProofOrderId = o.id;
  const pStat = getOrderPaymentStatus(o);

  setText("pm-order-id", formatOrderCode(o.id));
  setText("pm-customer-name", `${customerName(o.customerId)} (${formatCustomerCode(o.customerId)})`);
  setText("pm-customer-phone", customerPhone(o.customerId));
  setText("pm-total", money(orderTotal(o)));
  setText("pm-method", o.paymentMethod || "-");
  setText("pm-upload-date", o.paymentProofDate || "-");
  setText("pm-verified-at", o.verifiedAt || "-");

  const statusBadge = document.getElementById("pm-status-badge");
  if (statusBadge) {
    statusBadge.className = `pay ${paymentClass(pStat)}`;
    statusBadge.textContent = pStat;
  }

  const directSelect = document.getElementById("pm-direct-status");
  if (directSelect) directSelect.value = pStat;

  const noteDisplay = document.getElementById("pm-note-display");
  if (noteDisplay) {
    if (o.paymentNote) {
      noteDisplay.hidden = false;
      noteDisplay.innerHTML = `<strong>Catatan Verifikasi / Penolakan:</strong> ${esc(o.paymentNote)}`;
    } else {
      noteDisplay.hidden = true;
    }
  }

  toggleRejectReasonBox(openRejectBox);
  const rejectInput = document.getElementById("reject-reason-input");
  if (rejectInput) rejectInput.value = pStat === "Ditolak" ? o.paymentNote || "" : "";

  const emptyBox = document.getElementById("pm-empty-proof");
  const imgContainer = document.getElementById("pm-image-container");
  const imgEl = document.getElementById("pm-proof-img");
  const toolsEl = document.getElementById("pm-image-tools");
  const downloadEl = document.getElementById("pm-download-link");
  const fileLabel = document.getElementById("pm-file-label");

  if (imgContainer) imgContainer.classList.remove("zoomed");

  if (o.paymentProofId) {
    const dataUrl = await getProofImage(o.paymentProofId);
    if (dataUrl) {
      if (emptyBox) emptyBox.hidden = true;
      if (imgContainer) imgContainer.hidden = false;
      if (toolsEl) toolsEl.hidden = false;
      if (imgEl) imgEl.src = dataUrl;
      if (downloadEl) {
        downloadEl.href = dataUrl;
        downloadEl.download = o.paymentProofName || `bukti-order-${o.id}.jpg`;
      }
      if (fileLabel) {
        fileLabel.textContent = `Foto Bukti Pembayaran (${o.paymentProofName || "Gambar"})`;
      }
    } else {
      if (emptyBox) emptyBox.hidden = false;
      if (imgContainer) imgContainer.hidden = true;
      if (toolsEl) toolsEl.hidden = true;
      if (fileLabel) fileLabel.textContent = "Foto Bukti Pembayaran";
    }
  } else {
    if (emptyBox) emptyBox.hidden = false;
    if (imgContainer) imgContainer.hidden = true;
    if (toolsEl) toolsEl.hidden = true;
    if (fileLabel) fileLabel.textContent = "Foto Bukti Pembayaran";
  }

  document.getElementById("proof-modal")?.classList.add("show");
}

function closeProofModal() {
  document.getElementById("proof-modal")?.classList.remove("show");
  activeAdminProofOrderId = null;
}

function toggleZoomProofImage() {
  document.getElementById("pm-image-container")?.classList.toggle("zoomed");
}

function toggleRejectReasonBox(show) {
  const box = document.getElementById("reject-reason-box");
  if (!box) return;
  box.hidden = !show;
  if (show) {
    document.getElementById("reject-reason-input")?.focus();
  }
}

function updateOrderPaymentState(order, newStatus, note = "") {
  const nowStr = nowDateTime();
  order.payment = newStatus;
  order.paymentStatus = newStatus;
  order.paymentNote = note;
  if (newStatus === "Lunas" || newStatus === "Ditolak") {
    order.verifiedAt = nowStr;
  }
  if (newStatus === "Lunas") {
    order.paidAt = nowStr;
    if (!order.paymentMethod) order.paymentMethod = "Terverifikasi Admin";
    if (!order.paymentRef) {
      order.paymentRef = `VER-${today().replace(/-/g, "")}-${String(order.id).padStart(3, "0")}`;
    }
  }

  const existingHistory = [...db.payments]
    .reverse()
    .find(p => p.orderId === order.id);

  if (existingHistory) {
    existingHistory.status = newStatus;
    existingHistory.verifiedAt = order.verifiedAt || "";
    existingHistory.note = note;
  } else if (newStatus === "Lunas") {
    const paymentId = nextId(db.payments);
    db.payments.push({
      id: paymentId,
      refCode: order.paymentRef,
      orderId: order.id,
      customerId: order.customerId,
      customerName: customerName(order.customerId),
      method: order.paymentMethod || "Terverifikasi Admin",
      amount: orderTotal(order),
      date: order.paymentProofDate || nowStr,
      verifiedAt: nowStr,
      status: "Lunas",
      note
    });
  }
}

function quickVerifyOrder(orderId) {
  if (!validateAdminAccess()) return;
  const o = db.orders.find(x => x.id === Number(orderId));
  if (!o) return;

  if (!confirm(`Verifikasi pembayaran pesanan #${o.id} (${customerName(o.customerId)}) menjadi LUNAS?`)) {
    return;
  }

  updateOrderPaymentState(o, "Lunas", "Pembayaran telah diverifikasi oleh Admin.");
  save();
  renderAll();
  toast(`Pembayaran pesanan #${o.id} berhasil diverifikasi menjadi Lunas.`);
}

function verifyOrderPayment() {
  if (!validateAdminAccess() || !activeAdminProofOrderId) return;
  const o = db.orders.find(x => x.id === Number(activeAdminProofOrderId));
  if (!o) return;

  if (!confirm(`Verifikasi bukti pembayaran pesanan #${o.id} menjadi LUNAS?`)) {
    return;
  }

  updateOrderPaymentState(o, "Lunas", "Pembayaran telah diverifikasi oleh Admin.");
  save();
  renderAll();
  openProofModal(o.id);
  toast(`Pembayaran pesanan #${o.id} berhasil diverifikasi menjadi Lunas.`);
}

function confirmRejectPayment() {
  if (!validateAdminAccess() || !activeAdminProofOrderId) return;
  const o = db.orders.find(x => x.id === Number(activeAdminProofOrderId));
  if (!o) return;

  const reason = (document.getElementById("reject-reason-input")?.value || "").trim();
  if (!reason) {
    toast("Wajib mengisi alasan penolakan bukti pembayaran.");
    document.getElementById("reject-reason-input")?.focus();
    return;
  }

  updateOrderPaymentState(o, "Ditolak", reason);
  save();
  renderAll();
  openProofModal(o.id);
  toast(`Bukti pembayaran pesanan #${o.id} ditolak.`);
}

function applyDirectPaymentStatus() {
  if (!validateAdminAccess() || !activeAdminProofOrderId) return;
  const o = db.orders.find(x => x.id === Number(activeAdminProofOrderId));
  if (!o) return;

  const selected = document.getElementById("pm-direct-status")?.value || "Belum Lunas";
  if (selected === "Ditolak") {
    toggleRejectReasonBox(true);
    toast("Isi alasan penolakan lalu klik Konfirmasi Tolak Pembayaran.");
    return;
  }

  if (selected === "Lunas") {
    verifyOrderPayment();
    return;
  }

  updateOrderPaymentState(o, selected, "");
  save();
  renderAll();
  openProofModal(o.id);
  toast(`Status pembayaran pesanan #${o.id} diubah menjadi ${selected}.`);
}

/* ---------- Admin: Pelanggan ---------- */

function renderCustomers() {
  const tbody = document.getElementById("customers-body");
  if (!tbody) return;

  const q = (document.getElementById("customer-search")?.value || "").toLowerCase();
  const rows = db.customers.filter(c =>
    (formatCustomerCode(c.id) + " " + c.name + " " + c.phone + " " + c.address)
      .toLowerCase()
      .includes(q)
  );

  tbody.innerHTML = rows.length
    ? rows
        .map(c => {
          const linkedAcc = db.accounts.find(
            a => a.role === "customer" && String(a.customerId) === String(c.id)
          );
          const accBadge = linkedAcc
            ? `<span class="status status-selesai">@${esc(linkedAcc.username)}</span>`
            : `<span class="muted">Belum registrasi</span>`;
          return `<tr>
            <td><code>${esc(formatCustomerCode(c.id))}</code></td>
            <td><div class="customer-cell"><span class="mini-avatar">${esc(
              c.name.trim().charAt(0).toUpperCase() || "?"
            )}</span><strong>${esc(c.name)}</strong></div></td>
            <td>${esc(c.phone)}</td>
            <td>${esc(c.address)}</td>
            <td>${accBadge}</td>
            <td>${filterOrdersByCustomerId(c.id).length} pesanan</td>
            <td><div class="actions"><button class="icon-btn" onclick="editCustomer(${c.id})" title="Edit">✎</button><button class="icon-btn" onclick="deleteCustomer(${c.id})" title="Hapus">⌫</button></div></td>
          </tr>`;
        })
        .join("")
    : `<tr><td colspan="7" class="empty">Pelanggan tidak ditemukan.</td></tr>`;
}

function openCustomerModal(id = null) {
  if (!validateAdminAccess()) return;

  const modal = document.getElementById("customer-modal");
  const form = document.getElementById("customer-form");
  if (!modal || !form) return;

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
  if (!validateAdminAccess()) return;
  openCustomerModal(id);
}

function closeCustomerModal() {
  document.getElementById("customer-modal")?.classList.remove("show");
}

function submitCustomer(e) {
  e.preventDefault();
  if (!validateAdminAccess()) return;

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
  if (!validateAdminAccess()) return;

  if (db.orders.some(o => String(o.customerId) === String(id))) {
    alert("Pelanggan masih memiliki pesanan. Hapus atau pindahkan pesanan terlebih dahulu.");
    return;
  }

  if (confirm("Yakin ingin menghapus pelanggan ini?")) {
    db.customers = db.customers.filter(c => String(c.id) !== String(id));
    db.accounts = db.accounts.filter(
      a => a.role !== "customer" || String(a.customerId) !== String(id)
    );
    save();
    renderAll();
    toast("Pelanggan berhasil dihapus.");
  }
}

/* ---------- Admin: Laporan ---------- */

function renderReports() {
  const total = db.orders.reduce((s, o) => s + orderTotal(o), 0);
  const paid = db.orders
    .filter(o => getOrderPaymentStatus(o) === "Lunas")
    .reduce((s, o) => s + orderTotal(o), 0);
  const unpaid = total - paid;

  setText("report-total", money(total));
  setText("report-paid", money(paid));
  setText("report-unpaid", money(unpaid));
  setText("report-count", db.orders.length);

  const counts = TRACKING_STAGES.map(st => ({
    s: st.key,
    n: db.orders.filter(o =>
      st.key === "Diproses"
        ? o.status === "Diproses" || o.status === "Sedang Dicuci"
        : o.status === st.key
    ).length
  }));
  const max = Math.max(1, ...counts.map(x => x.n));

  const el = document.getElementById("status-bars");
  if (el) {
    el.innerHTML = counts
      .map(
        x =>
          `<div><div class="bar-label"><span>${esc(x.s)}</span><strong>${x.n} pesanan</strong></div><div class="bar-track"><div class="bar-fill" style="width:${(x.n / max) * 100}%"></div></div></div>`
      )
      .join("");
  }

  const tbody = document.getElementById("report-body");
  if (tbody) {
    tbody.innerHTML = db.orders.length
      ? [...db.orders]
          .sort((a, b) => b.id - a.id)
          .map(o => {
            const pStat = getOrderPaymentStatus(o);
            return `<tr><td>#${o.id}</td><td>${esc(o.date)}</td><td>${esc(
              customerName(o.customerId)
            )}</td><td>${esc(o.service)}</td><td><span class="status ${statusClass(
              o.status
            )}">${esc(o.status)}</span></td><td>${money(
              orderTotal(o)
            )}</td><td><span class="pay ${paymentClass(pStat)}">${esc(
              pStat
            )}</span></td></tr>`;
          })
          .join("")
      : `<tr><td colspan="7" class="empty">Belum ada transaksi.</td></tr>`;
  }
}

/* ---------- Customer: Strict Ownership Filtering by customerId ---------- */

function getAccessibleCustomerOrders() {
  const myCustomerId = getCurrentCustomerId();
  return filterOrdersByCustomerId(myCustomerId, db.orders);
}

function renderCustomerWelcomeAndStats() {
  const myCustomerId = getCurrentCustomerId();
  const myCustomer = customerById(myCustomerId);
  const cName =
    myCustomer?.name ||
    currentSession?.displayName ||
    "Customer";

  setText("cust-welcome-title", `Hello, ${cName}!`);
  setText(
    "cust-account-owner-label",
    myCustomer
      ? `${myCustomer.name} · ${formatCustomerCode(myCustomer.id)}`
      : cName
  );

  const myOrders = filterOrdersByCustomerId(myCustomerId);
  const total = myOrders.length;
  const process = myOrders.filter(o => isProcessingStatus(o.status)).length;
  const done = myOrders.filter(o => o.status === "Selesai").length;

  setText("cust-stat-total", total);
  setText("cust-stat-process", process);
  setText("cust-stat-done", done);
}

function loadLoggedCustomerOrders() {
  renderCustomerWelcomeAndStats();
  const myCustomerId = getCurrentCustomerId();
  const myOrders = [...filterOrdersByCustomerId(myCustomerId)].sort(
    (a, b) => b.id - a.id
  );
  const feedbackEl = document.getElementById("customer-search-feedback");
  const matchesPanel = document.getElementById("customer-matches-panel");
  const orderView = document.getElementById("customer-order-view");

  const qInput = document.getElementById("track-query");
  const pSelect = document.getElementById("track-phone");
  if (qInput) qInput.value = "";
  if (pSelect) pSelect.value = "";

  if (myCustomerId === null || !myOrders.length) {
    selectedCustomerOrderId = null;
    matchedCustomerOrders = [];
    if (matchesPanel) matchesPanel.hidden = true;
    if (orderView) orderView.hidden = true;
    if (feedbackEl) {
      feedbackEl.hidden = false;
      feedbackEl.className = "panel empty";
      feedbackEl.innerHTML = `
        <div class="empty-laundry-state">
          <span class="empty-laundry-icon">🧺</span>
          <strong>Belum Ada Pesanan Laundry untuk Akun Anda</strong>
          <small>Hanya pesanan yang terhubung dengan Customer ID akun Anda yang ditampilkan di halaman ini.</small>
        </div>`;
    }
    return;
  }

  if (feedbackEl) feedbackEl.hidden = true;
  matchedCustomerOrders = myOrders;
  selectedCustomerOrderId = myOrders[0].id;

  if (matchesPanel) {
    matchesPanel.hidden = false;
    renderCustomerMatchesList();
  }
  renderCustomerOrderDetail(selectedCustomerOrderId);
}

function renderCustomerQuickChips() {
  const wrap = document.getElementById("customer-quick-chips");
  if (!wrap) return;

  const myCustomerId = getCurrentCustomerId();
  const myOrders = [...filterOrdersByCustomerId(myCustomerId)].sort(
    (a, b) => b.id - a.id
  );

  if (!myOrders.length) {
    wrap.innerHTML = `<span class="quick-chip-label">Belum ada pesanan tercatat untuk akun ini.</span>`;
    return;
  }

  const sampleOrders = myOrders.slice(0, 5);
  wrap.innerHTML =
    `<span class="quick-chip-label">Pesanan Milik Anda:</span>` +
    sampleOrders
      .map(
        o =>
          `<button type="button" class="quick-chip" onclick="quickSelectOrder(${o.id})">#${o.id} · ${esc(o.service)} (${esc(o.status)})</button>`
      )
      .join("");
}

function quickSelectOrder(orderId) {
  const myCustomerId = getCurrentCustomerId();
  const myOrders = filterOrdersByCustomerId(myCustomerId);
  const o = myOrders.find(x => String(x.id) === String(orderId));
  if (!o || !validateCustomerAccess(o)) {
    toast("Akses ditolak: Anda hanya dapat melihat pesanan milik Anda sendiri.");
    return;
  }
  selectMatchedOrder(o.id);
}

function handleCustomerTrackSubmit(e) {
  e.preventDefault();
  const query = (document.getElementById("track-query")?.value || "").trim();
  const payStatusFilter = (document.getElementById("track-phone")?.value || "").trim();

  if (!query && !payStatusFilter) {
    loadLoggedCustomerOrders();
    return;
  }
  searchCustomerOrders(query, payStatusFilter);
}

function searchCustomerOrders(query, payStatusFilter = "", preferredOrderId = null) {
  const feedbackEl = document.getElementById("customer-search-feedback");
  const matchesPanel = document.getElementById("customer-matches-panel");
  const orderView = document.getElementById("customer-order-view");

  // WAJIB: Ambil hanya pesanan yang customerId-nya cocok dengan akun yang sedang login
  const myCustomerId = getCurrentCustomerId();
  const myOrders = filterOrdersByCustomerId(myCustomerId, db.orders);
  const myCustomer = customerById(myCustomerId);
  const myOwnName = (myCustomer?.name || "").toLowerCase();

  const qRaw = (query || "").trim().toLowerCase();
  const qIdClean = qRaw.replace(/^(#|bl-0*)/i, "");

  const matched = [...myOrders]
    .sort((a, b) => b.id - a.id)
    .filter(o => {
      // Pastikan kepemilikan customerId sekali lagi
      if (String(o.customerId) !== String(myCustomerId)) return false;

      const pStat = getOrderPaymentStatus(o);
      if (
        payStatusFilter &&
        ["Belum Lunas", "Menunggu Verifikasi", "Lunas", "Ditolak"].includes(payStatusFilter) &&
        pStat !== payStatusFilter
      ) {
        return false;
      }

      if (!qRaw) return true;

      const idMatch =
        String(o.id) === qIdClean ||
        formatOrderCode(o.id).toLowerCase().includes(qRaw);
      const serviceMatch = (o.service || "").toLowerCase().includes(qRaw);
      const statusMatch = (o.status || "").toLowerCase().includes(qRaw);
      const dateMatch = (o.date || "").toLowerCase().includes(qRaw);
      const ownNameMatch = myOwnName && myOwnName.includes(qRaw);

      return idMatch || serviceMatch || statusMatch || dateMatch || ownNameMatch;
    });

  if (!matched.length) {
    selectedCustomerOrderId = null;
    matchedCustomerOrders = [];
    if (matchesPanel) matchesPanel.hidden = true;
    if (orderView) orderView.hidden = true;
    if (feedbackEl) {
      feedbackEl.hidden = false;
      feedbackEl.className = "panel empty";
      feedbackEl.innerHTML = `
        <div class="empty-laundry-state">
          <span class="empty-laundry-icon">🧺</span>
          <strong>Pesanan Tidak Ditemukan</strong>
          <small>Tidak ada pesanan pada akun Anda yang cocok dengan pencarian "${esc(query)}".</small>
        </div>`;
    }
    toast("Pesanan tidak ditemukan pada akun Anda.");
    return;
  }

  matchedCustomerOrders = matched;
  if (feedbackEl) feedbackEl.hidden = true;

  const targetId =
    preferredOrderId && matched.some(o => String(o.id) === String(preferredOrderId))
      ? preferredOrderId
      : matched[0].id;

  selectedCustomerOrderId = targetId;

  if (matchesPanel) {
    matchesPanel.hidden = false;
    renderCustomerMatchesList();
  }

  renderCustomerOrderDetail(targetId);
}

function renderCustomerMatchesList() {
  const matchesList = document.getElementById("customer-matches-list");
  if (!matchesList) return;

  const myCustomerId = getCurrentCustomerId();
  const safeList = matchedCustomerOrders.filter(
    o => String(o.customerId) === String(myCustomerId)
  );

  matchesList.innerHTML = safeList
    .map(o => {
      const active = String(o.id) === String(selectedCustomerOrderId) ? "active" : "";
      const pStat = getOrderPaymentStatus(o);
      return `<button type="button" class="match-card ${active}" onclick="selectMatchedOrder(${o.id})">
        <div class="match-card-top">
          <strong>${esc(formatOrderCode(o.id))}</strong>
          <span class="status ${statusClass(o.status)}">${esc(o.status)}</span>
        </div>
        <div><strong>${esc(customerName(o.customerId))}</strong></div>
        <small>${esc(o.service)} · ${o.weight} kg · ${money(orderTotal(o))}</small>
        <small>Tanggal: ${esc(o.date)} · Bayar: <span class="pay ${paymentClass(pStat)}">${esc(pStat)}</span></small>
      </button>`;
    })
    .join("");
}

function selectMatchedOrder(orderId) {
  const myCustomerId = getCurrentCustomerId();
  const myOrders = filterOrdersByCustomerId(myCustomerId);
  const target = myOrders.find(o => String(o.id) === String(orderId));
  if (!target || !validateCustomerAccess(target)) {
    toast("Akses ditolak: Pesanan bukan milik akun Anda.");
    return;
  }

  selectedCustomerOrderId = target.id;
  clearSelectedProofFile();
  renderCustomerMatchesList();
  renderCustomerOrderDetail(selectedCustomerOrderId);
}

async function renderCustomerOrderDetail(orderId) {
  const orderView = document.getElementById("customer-order-view");
  const myCustomerId = getCurrentCustomerId();
  const myOrders = filterOrdersByCustomerId(myCustomerId);
  const o = myOrders.find(x => String(x.id) === String(orderId));

  if (!o || !orderView || !validateCustomerAccess(o)) {
    if (orderView) orderView.hidden = true;
    return;
  }

  orderView.hidden = false;
  const cName = customerName(o.customerId);
  const cPhone = customerPhone(o.customerId);
  const total = orderTotal(o);
  const code = formatOrderCode(o.id);
  const pStat = getOrderPaymentStatus(o);

  // 1. Update Tracking Timeline
  const stageIdx = getStageIndex(o.status);
  const progressPercent = Math.round(((stageIdx + 1) / TRACKING_STAGES.length) * 100);
  const fillEl = document.getElementById("cust-tracking-fill");
  if (fillEl) fillEl.style.width = `${progressPercent}%`;

  const statusBadge = document.getElementById("cust-current-status-badge");
  if (statusBadge) {
    statusBadge.className = `status ${statusClass(o.status)}`;
    statusBadge.textContent = `${o.status} (${progressPercent}%)`;
  }

  const stepsWrap = document.getElementById("cust-tracking-steps");
  if (stepsWrap) {
    stepsWrap.innerHTML = TRACKING_STAGES.map((st, idx) => {
      const stateClass =
        idx < stageIdx || o.status === "Selesai"
          ? "done"
          : idx === stageIdx
            ? "current"
            : "";
      const iconText =
        idx < stageIdx || o.status === "Selesai" ? "✓" : String(idx + 1);
      return `<div class="track-step ${stateClass}">
        <div class="track-step-num">${iconText}</div>
        <strong>${esc(st.title)}</strong>
        <small>${esc(st.desc)}</small>
      </div>`;
    }).join("");
  }

  // 2. Update Order Detail Card
  setText("cust-detail-code", `#${o.id}`);
  setText("cust-detail-name", cName);
  setText("cust-detail-id", code);
  setText("cust-detail-phone", cPhone);
  setText("cust-detail-date", o.date);
  setText("cust-detail-eta", estimateCompletionDate(o));
  setText("cust-detail-service", o.service);
  setText("cust-detail-weight", `${o.weight} kg`);
  setText("cust-detail-price", `${money(o.price)} / kg`);
  setText("cust-detail-note", o.note || "-");
  setText("cust-detail-total", money(total));

  const detailPayBadge = document.getElementById("cust-detail-pay-badge");
  if (detailPayBadge) {
    detailPayBadge.className = `pay ${paymentClass(pStat)}`;
    detailPayBadge.textContent = pStat;
  }

  // 3. Update Payment & Upload Proof Panel
  setText("pay-order-code", code);
  setText("pay-customer-name", cName);
  setText("pay-total-amount", money(total));

  const payStatusBadge = document.getElementById("pay-status-badge");
  if (payStatusBadge) {
    payStatusBadge.className = `pay ${paymentClass(pStat)}`;
    payStatusBadge.textContent = pStat;
  }

  const proofDateRow = document.getElementById("pay-proof-date-row");
  if (proofDateRow) {
    proofDateRow.hidden = !o.paymentProofDate;
    setText("pay-proof-date-text", o.paymentProofDate || "-");
  }

  const rejectedBox = document.getElementById("payment-rejected-alert");
  if (rejectedBox) {
    if (pStat === "Ditolak") {
      rejectedBox.hidden = false;
      setText(
        "payment-rejected-reason",
        `Alasan Penolakan: ${o.paymentNote || "Bukti pembayaran tidak valid."}`
      );
    } else {
      rejectedBox.hidden = true;
    }
  }

  const pendingBox = document.getElementById("payment-pending-alert");
  const submittedWrap = document.getElementById("cust-submitted-proof-wrap");
  const submittedImg = document.getElementById("cust-submitted-proof-img");

  if (pendingBox) {
    if (pStat === "Menunggu Verifikasi") {
      pendingBox.hidden = false;
      setText(
        "payment-pending-info",
        `Metode: ${o.paymentMethod || "-"} · Dikirim: ${o.paymentProofDate || "-"}`
      );
      if (o.paymentProofId && submittedWrap && submittedImg) {
        const imgData = await getProofImage(o.paymentProofId);
        if (imgData) {
          submittedWrap.hidden = false;
          submittedImg.src = imgData;
          setText("cust-submitted-proof-name", o.paymentProofName || "Bukti Pembayaran");
          setText("cust-submitted-proof-time", `Diunggah pada ${o.paymentProofDate || "-"}`);
        } else {
          submittedWrap.hidden = true;
        }
      }
    } else {
      pendingBox.hidden = true;
    }
  }

  const actionArea = document.getElementById("payment-action-area");
  const paidArea = document.getElementById("payment-paid-area");
  const isPaid = pStat === "Lunas";

  if (actionArea) actionArea.hidden = isPaid;
  if (paidArea) {
    paidArea.hidden = !isPaid;
    const methodText = o.paymentMethod || "Terverifikasi";
    const verifiedText = o.verifiedAt || o.paidAt || o.date;
    setText(
      "paid-info-text",
      `Metode: ${methodText} · Diverifikasi pada: ${verifiedText}`
    );
  }
}

function resetCustomerSearch(silent = false) {
  const form = document.getElementById("customer-track-form");
  form?.reset();
  selectedCustomerOrderId = null;
  matchedCustomerOrders = [];
  clearSelectedProofFile();

  const feedbackEl = document.getElementById("customer-search-feedback");
  const matchesPanel = document.getElementById("customer-matches-panel");
  const orderView = document.getElementById("customer-order-view");

  if (feedbackEl) feedbackEl.hidden = true;
  if (matchesPanel) matchesPanel.hidden = true;
  if (orderView) orderView.hidden = true;
  if (!silent) toast("Pencarian pesanan direset.");
}

function updatePaymentMethodPreview() {
  const selected =
    document.querySelector('input[name="sim-pay-method"]:checked')?.value || "QRIS";
  const isQRIS = selected.includes("QRIS");

  document
    .getElementById("label-method-qris")
    ?.classList.toggle("active", isQRIS);
  document
    .getElementById("label-method-bank")
    ?.classList.toggle("active", !isQRIS);

  const qrisPreview = document.getElementById("pay-preview-qris");
  const bankPreview = document.getElementById("pay-preview-bank");
  if (qrisPreview) qrisPreview.hidden = !isQRIS;
  if (bankPreview) bankPreview.hidden = isQRIS;
}

/* ---------- Customer: Upload Payment Proof ---------- */

async function handleProofFileChange(e) {
  const file = e.target.files?.[0];
  if (!file) return;

  const isTypeValid =
    ALLOWED_IMAGE_TYPES.includes(file.type) || ALLOWED_IMAGE_EXT.test(file.name);
  if (!isTypeValid) {
    toast("Format file tidak didukung. Gunakan gambar JPG, JPEG, PNG, atau WEBP.");
    clearSelectedProofFile();
    return;
  }

  if (file.size > MAX_PROOF_BYTES) {
    toast("Ukuran file terlalu besar! Maksimal ukuran file adalah 2 MB.");
    clearSelectedProofFile();
    return;
  }

  try {
    const dataUrl = await compressImageToDataURL(file);
    pendingProofFile = file;
    pendingProofDataUrl = dataUrl;

    const previewBox = document.getElementById("proof-preview-box");
    const previewImg = document.getElementById("proof-preview-img");
    const dropzone = document.getElementById("proof-dropzone");

    if (previewImg) previewImg.src = dataUrl;
    setText("proof-file-name", file.name);
    setText("proof-file-size", `${(file.size / 1024).toFixed(1)} KB`);
    if (previewBox) previewBox.hidden = false;
    if (dropzone) dropzone.hidden = true;
  } catch (err) {
    toast("Gagal memuat preview gambar. Pilih file gambar lain.");
    clearSelectedProofFile();
  }
}

function clearSelectedProofFile() {
  pendingProofFile = null;
  pendingProofDataUrl = null;
  const fileInput = document.getElementById("proof-file-input");
  if (fileInput) fileInput.value = "";
  const previewBox = document.getElementById("proof-preview-box");
  const dropzone = document.getElementById("proof-dropzone");
  if (previewBox) previewBox.hidden = true;
  if (dropzone) dropzone.hidden = false;
}

async function submitPaymentProof() {
  if (!selectedCustomerOrderId) {
    toast("Pilih pesanan terlebih dahulu.");
    return;
  }

  const myCustomerId = getCurrentCustomerId();
  const myOrders = filterOrdersByCustomerId(myCustomerId);
  const order = myOrders.find(o => String(o.id) === String(selectedCustomerOrderId));
  if (!order || !validateCustomerAccess(order)) {
    toast("Akses ditolak: Pesanan tidak ditemukan atau bukan milik akun Anda.");
    return;
  }

  if (getOrderPaymentStatus(order) === "Lunas") {
    toast("Pembayaran pesanan ini sudah diverifikasi Lunas.");
    return;
  }

  if (!pendingProofFile || !pendingProofDataUrl) {
    toast("Silakan pilih file gambar bukti pembayaran terlebih dahulu.");
    return;
  }

  const method =
    document.querySelector('input[name="sim-pay-method"]:checked')?.value || "QRIS";
  const uploadTime = nowDateTime();
  const proofId = `proof_${order.id}_${Date.now()}`;

  const saved = await saveProofImage(proofId, pendingProofDataUrl);
  if (!saved) return;

  order.paymentMethod = method;
  order.paymentProofId = proofId;
  order.paymentProofName = pendingProofFile.name;
  order.paymentProofDate = uploadTime;
  order.paymentStatus = "Menunggu Verifikasi";
  order.payment = "Menunggu Verifikasi";
  order.paymentNote = "";
  order.verifiedAt = "";

  const paymentId = nextId(db.payments);
  const refCode = `PRF-${today().replace(/-/g, "")}-${String(paymentId).padStart(3, "0")}`;
  order.paymentRef = refCode;

  db.payments.push({
    id: paymentId,
    refCode,
    orderId: order.id,
    customerId: order.customerId,
    customerName: customerName(order.customerId),
    method,
    amount: orderTotal(order),
    date: uploadTime,
    verifiedAt: "",
    status: "Menunggu Verifikasi",
    proofName: pendingProofFile.name,
    note: ""
  });

  save();
  clearSelectedProofFile();
  renderAll();
  if (matchedCustomerOrders.length) {
    renderCustomerMatchesList();
  }
  await renderCustomerOrderDetail(order.id);
  toast("Bukti pembayaran berhasil dikirim! Status kini: Menunggu Verifikasi Admin.");
}

function openReceiptModal(orderId = selectedCustomerOrderId) {
  const o = db.orders.find(x => String(x.id) === String(orderId));
  if (!o) return;

  const account = getLoggedInAccount();
  if (!account) return;

  if (account.role === "customer" && !validateCustomerAccess(o)) {
    toast("Akses ditolak: Anda hanya dapat melihat bukti pembayaran pesanan milik Anda.");
    return;
  }

  const paymentRecord = [...db.payments]
    .reverse()
    .find(p => String(p.orderId) === String(o.id));

  const refCode =
    paymentRecord?.refCode ||
    o.paymentRef ||
    `INV-${String(o.id).padStart(4, "0")}`;
  const method =
    o.paymentMethod || paymentRecord?.method || "Terverifikasi Admin";
  const paidDate = o.verifiedAt || o.paidAt || paymentRecord?.date || o.date;

  setText("rcp-ref", refCode);
  setText("rcp-order-id", formatOrderCode(o.id));
  setText("rcp-customer", customerName(o.customerId));
  setText("rcp-service", `${o.service} (${o.weight} kg × ${money(o.price)})`);
  setText("rcp-method", method);
  setText("rcp-date", paidDate);
  setText("rcp-total", money(orderTotal(o)));

  document.getElementById("receipt-modal")?.classList.add("show");
}

function closeReceiptModal() {
  document.getElementById("receipt-modal")?.classList.remove("show");
}

function renderCustomerHistory() {
  const tbody = document.getElementById("customer-history-body");
  if (!tbody) return;

  const q = (document.getElementById("cust-history-search")?.value || "").toLowerCase();
  const myCustomerId = getCurrentCustomerId();
  const myOrders = filterOrdersByCustomerId(myCustomerId).filter(
    o =>
      o.paymentProofDate ||
      getOrderPaymentStatus(o) !== "Belum Lunas"
  );

  const filtered = [...myOrders]
    .sort((a, b) => b.id - a.id)
    .filter(o => {
      const code = formatOrderCode(o.id).toLowerCase();
      const cName = customerName(o.customerId).toLowerCase();
      const method = (o.paymentMethod || "").toLowerCase();
      const pStat = getOrderPaymentStatus(o).toLowerCase();
      return (
        code.includes(q) ||
        cName.includes(q) ||
        method.includes(q) ||
        pStat.includes(q)
      );
    });

  tbody.innerHTML = filtered.length
    ? filtered
        .map(o => {
          const pStat = getOrderPaymentStatus(o);
          let actionHtml = "-";
          if (pStat === "Lunas") {
            actionHtml = `<button type="button" class="btn btn-light btn-sm" onclick="openReceiptModal(${o.id})">⎙ Struk Lunas</button>`;
          } else if (pStat === "Ditolak") {
            actionHtml = `<span style="color:var(--red);font-weight:600">Alasan: ${esc(o.paymentNote || "-")}</span>`;
          } else if (pStat === "Menunggu Verifikasi") {
            actionHtml = `<span class="muted">${esc(o.paymentProofName || "Sedang diperiksa Admin")}</span>`;
          }
          return `<tr>
            <td><strong>#${o.id}</strong></td>
            <td>${esc(customerName(o.customerId))}</td>
            <td>${esc(o.paymentMethod || "-")}</td>
            <td>${esc(o.paymentProofDate || "-")}</td>
            <td>${esc(o.verifiedAt || "-")}</td>
            <td><strong>${money(orderTotal(o))}</strong></td>
            <td><span class="pay ${paymentClass(pStat)}">${esc(pStat)}</span></td>
            <td>${actionHtml}</td>
          </tr>`;
        })
        .join("")
    : `<tr><td colspan="8" class="empty">Belum ada riwayat pengiriman bukti pembayaran pada akun Anda.</td></tr>`;
}

/* ---------- Init ---------- */

document.addEventListener("DOMContentLoaded", () => {
  navSetup();
  renderAll();

  document.getElementById("login-form")?.addEventListener("submit", handleLogin);
  document.getElementById("register-form")?.addEventListener("submit", handleRegister);
  document
    .getElementById("admin-password-form")
    ?.addEventListener("submit", handleChangeAdminPassword);
  document.getElementById("order-search")?.addEventListener("input", renderOrders);
  document.getElementById("status-filter")?.addEventListener("change", renderOrders);
  document.getElementById("payment-filter")?.addEventListener("change", renderOrders);
  document.getElementById("order-form")?.addEventListener("submit", submitOrder);
  document.getElementById("customer-search")?.addEventListener("input", renderCustomers);
  document.getElementById("customer-form")?.addEventListener("submit", submitCustomer);
  document
    .getElementById("customer-track-form")
    ?.addEventListener("submit", handleCustomerTrackSubmit);
  document
    .getElementById("track-phone")
    ?.addEventListener("change", handleCustomerTrackSubmit);
  document
    .getElementById("cust-history-search")
    ?.addEventListener("input", renderCustomerHistory);
  document
    .getElementById("proof-file-input")
    ?.addEventListener("change", handleProofFileChange);

  document.addEventListener("keydown", e => {
    if (e.key === "Escape") {
      closeOrderModal();
      closeCustomerModal();
      closeProofModal();
      closeReceiptModal();
      document.querySelector(".sidebar")?.classList.remove("open");
    }
  });

  [
    ["order-modal", closeOrderModal],
    ["customer-modal", closeCustomerModal],
    ["proof-modal", closeProofModal],
    ["receipt-modal", closeReceiptModal]
  ].forEach(([id, fn]) =>
    document.getElementById(id)?.addEventListener("click", e => {
      if (e.target.id === id) fn();
    })
  );

  // Sinkronisasi otomatis antar-tab browser apabila Local Storage berubah
  window.addEventListener("storage", e => {
    if (e.key === STORAGE_KEY) {
      db = loadData();
      renderAll();
    } else if (e.key === SESSION_KEY) {
      currentSession = loadSession();
      applySessionUI();
    }
  });

  applySessionUI();
  const activeAccount = getLoggedInAccount();
  if (currentSession && activeAccount) {
    showView(
      activeAccount.role === "customer" ? "customer-dashboard" : "dashboard"
    );
    if (activeAccount.role === "customer") {
      loadLoggedCustomerOrders();
    }
  }
});
