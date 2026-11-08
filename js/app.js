/* ==========================================================================
   KrishiLink AI — Core Application Logic
   Smart India Hackathon 2026 · Team AgroNEX (PS #26132)
   ========================================================================== */

(function () {
  "use strict";

  /* ============ APP STATE ============ */
  let state = {
    theme: 'auto',
    lang: 'en',
    authed: false,
    role: 'farmer',
    user: { name: 'Ramesh Chaudhary', phone: '9876543210', village: 'Ghaziabad, UP' },
    route: 'landing',
    page: 'dashboard',
    previousRoute: 'landing',
    loginStep: 'phone',
    loginPhone: '',
    cropIdx: 0,
    qty: 20,
    grade: 'A',
    calcResult: null,
    beaconStatus: 'idle',
    beaconOffers: [],
    selectedOffer: null,
    showOtpModal: false,
    showAgreementModal: false,
    selectedBuyerModal: null,
    poolAmount: 32,
    poolTarget: 60,
    joinedPool: false,
    weatherRegion: 'r1',
    faqTab: 'all',
    faqQuery: '',
    faqOpen: {},
    chat: [],
    chatBusy: false,
    chatListening: false,
    consentGiven: false,
    legalPage: 'privacy',
    analytics: { views: 0, calcs: 0, broadcasts: 0, offersAccepted: 0, chats: 0 },
    lastChatSentAt: 0,
    lastOtpSubmitAt: 0,
  };

  /* ============ PERSISTENCE & ANALYTICS ============ */
  function loadState() {
    try {
      const raw = localStorage.getItem('krishilink_state_v2');
      if (raw) {
        const saved = JSON.parse(raw);
        state = Object.assign({}, state, saved, {
          route: saved.authed ? 'app' : 'landing',
          beaconStatus: 'idle',
          beaconOffers: [],
          showOtpModal: false,
          showAgreementModal: false,
          selectedBuyerModal: null,
          chat: [],
          chatBusy: false,
          chatListening: false,
          analytics: Object.assign({ views: 0, calcs: 0, broadcasts: 0, offersAccepted: 0, chats: 0 }, saved.analytics || {}),
        });
      }
    } catch (e) {
      console.warn("Storage load warning:", e);
    }
  }

  function persist() {
    try {
      const toSave = {
        theme: state.theme,
        lang: state.lang,
        authed: state.authed,
        role: state.role,
        user: state.user,
        page: state.page,
        poolAmount: state.poolAmount,
        joinedPool: state.joinedPool,
        consentGiven: state.consentGiven,
        analytics: state.analytics,
      };
      localStorage.setItem('krishilink_state_v2', JSON.stringify(toSave));
    } catch (e) {
      console.warn("Storage persist warning:", e);
    }
  }

  function trackEvent(name) {
    if (state.analytics[name] == null) state.analytics[name] = 0;
    state.analytics[name] += 1;
    persist();
  }

  /* ============ I18N HELPERS ============ */
  function t(key) {
    const dict = I18N[state.lang] || I18N.en;
    return (dict && dict[key] != null) ? dict[key] : (I18N.en[key] || key);
  }

  function cropName(c) {
    return state.lang === 'hi' ? c.hi : c.en;
  }

  function regionName(r) {
    return state.lang === 'hi' ? r.hi : r.en;
  }

  function wxName(w) {
    return state.lang === 'hi' ? w.hi : w.en;
  }

  /* ============ FORMATTING & MATH UTILS ============ */
  function fmtINR(n) {
    n = Math.round(n);
    try {
      return '₹' + n.toLocaleString('en-IN');
    } catch (e) {
      return '₹' + n;
    }
  }

  function escapeHtml(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  function hashStr(s) {
    let h = 0;
    for (let i = 0; i < s.length; i++) {
      h = (Math.imul(31, h) + s.charCodeAt(i)) | 0;
    }
    return h;
  }

  function mulberry32(seed) {
    return function () {
      seed |= 0;
      seed = (seed + 0x6D2B79F5) | 0;
      let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  function dayOfYear() {
    const now = new Date();
    const start = new Date(now.getFullYear(), 0, 0);
    return Math.floor((now - start) / 86400000);
  }

  /* ============ WEATHER GENERATOR ============ */
  function genWeather(regionId, dayOffset) {
    const region = REGIONS.find(function (r) { return r.id === regionId; }) || REGIONS[0];
    const seed = hashStr(regionId + '-' + (dayOfYear() + dayOffset));
    const rnd = mulberry32(seed);
    const rainRoll = rnd();

    let condIdx;
    if (rainRoll < 0.12) condIdx = 4;      // storm
    else if (rainRoll < 0.30) condIdx = 3; // rain
    else if (rainRoll < 0.55) condIdx = 2; // cloudy
    else if (rainRoll < 0.80) condIdx = 1; // partly
    else condIdx = 0;                      // sunny

    const cond = WX_CONDITIONS[condIdx];
    const baseTemp = 30 + region.bias - dayOffset * 0.3;
    const tempHigh = Math.round(baseTemp + rnd() * 4 - (condIdx >= 3 ? 4 : 0));
    const tempLow = Math.round(tempHigh - 8 - rnd() * 3);
    const humidity = Math.round(40 + condIdx * 10 + rnd() * 10);
    const wind = Math.round(6 + rnd() * 14);
    const rainChance = Math.round(condIdx * 20 + rnd() * 15);

    return { cond: cond, tempHigh: tempHigh, tempLow: tempLow, humidity: humidity, wind: wind, rainChance: rainChance, regionName: regionName(region) };
  }

  function harvestAdvisory(wx, crop) {
    const perishable = crop ? crop.perishable : false;
    if (wx.cond.key === 'storm' || (wx.cond.key === 'rain' && wx.rainChance > 55)) {
      return {
        icon: '⚠️',
        title: state.lang === 'hi' ? 'भारी बारिश और नमी की चेतावनी' : 'Heavy rain & moisture alert',
        body: state.lang === 'hi'
          ? (perishable ? 'जल्दी खराब होने वाली फसल (टमाटर/प्याज) है — आज ही बेचना या ढके हुए भंडारण की व्यवस्था करना सर्वोत्तम रहेगा।' : 'तुड़ाई व खुले परिवहन में देरी हो सकती है — ढके हुए पक्के भंडारण की व्यवस्था तुरंत करें।')
          : (perishable ? 'For a perishable harvest, selling today or arranging covered cold storage is critical to avoid distress spoilage.' : 'Harvest and transport delays likely — ensure covered storage and avoid unpaved transport routes.')
      };
    }
    if (wx.cond.key === 'sunny' && wx.humidity < 50) {
      return {
        icon: '☀️',
        title: state.lang === 'hi' ? 'तुड़ाई व ढुलाई के लिए उत्तम मौसम' : 'Prime harvest & transit window',
        body: state.lang === 'hi'
          ? 'सूखा व साफ़ मौसम है — तुड़ाई, सुखाने और मंडियों/खरीदारों तक परिवहन के लिए आदर्श समय है।'
          : 'Dry, clear skies across the district — ideal window for field harvesting, sun drying, and long-distance transport.'
      };
    }
    return {
      icon: '🌤️',
      title: state.lang === 'hi' ? 'स्थिर मौसमी परिस्थितियां' : 'Stable atmospheric conditions',
      body: state.lang === 'hi'
        ? 'अगले 4-5 दिन मौसम सामान्य रहेगा — अपनी योजना के अनुसार सर्वोत्तम नेट भाव देखकर सौदा करें।'
        : 'No acute weather risk in the next 5 days — proceed with planned digital twin market timing.'
    };
  }

  /* ============ NET REALIZATION CALCULATOR ============ */
  function calcForOption(crop, qty, grade, opt, isBuyer) {
    const gross = crop.base * (isBuyer ? opt.offerMult : opt.priceMult) * qty;
    const transport = Math.round(opt.distanceKm * 9 * qty / 10);
    const commission = Math.round(isBuyer ? gross * 0.02 : gross * opt.commission);
    const gradeDeductPct = grade === 'A' ? 0.01 : (grade === 'B' ? 0.045 : 0.09);
    const quality = Math.round(gross * gradeDeductPct);
    const storage = Math.round(crop.perishable ? qty * 35 : qty * 10);

    const trustAvg = isBuyer
      ? (Object.values(opt.trust).reduce(function (a, b) { return a + b; }, 0) / 5)
      : 4.5;
    const riskPct = isBuyer ? Math.max(0.01, (5 - trustAvg) * 0.035) : 0.02;
    const risk = Math.round(gross * riskPct);

    const net = Math.round(gross - transport - commission - quality - storage - risk);

    return {
      name: opt.name,
      distanceKm: opt.distanceKm,
      gross: gross,
      transport: transport,
      commission: commission,
      quality: quality,
      storage: storage,
      risk: risk,
      net: net,
      isBuyer: isBuyer,
      trustAvg: trustAvg,
      raw: opt
    };
  }

  function runCalculation() {
    const crop = CROPS[state.cropIdx];
    const qty = state.qty;
    const grade = state.grade;

    const mandiOptions = MANDIS.map(function (m) { return calcForOption(crop, qty, grade, m, false); });
    const buyerOptions = BUYERS.slice(0, 3).map(function (b) { return calcForOption(crop, qty, grade, b, true); });

    const all = mandiOptions.concat(buyerOptions).sort(function (a, b) { return b.net - a.net; });
    const wx = genWeather(state.weatherRegion, 0);

    let action = 'sell', actionReason = '';
    if (crop.perishable && (wx.cond.key === 'storm' || wx.rainChance > 55)) {
      action = 'sell';
      actionReason = state.lang === 'hi'
        ? 'आने वाले दिनों में बारिश का खतरा है और यह जल्दी खराब होने वाली फसल है — आज ही बेचना सबसे सुरक्षित है।'
        : 'Adverse weather approaching and this crop is perishable — selling today locks in maximum realization before rot risk.';
    } else if (!crop.perishable && all[0].net < all[0].gross * 0.85) {
      action = 'store';
      actionReason = state.lang === 'hi'
        ? 'कटौतियां (परिवहन व कमीशन) अधिक हैं और फसल का शेल्फ-लाइफ अच्छा है — कुछ दिन पक्के गोदाम में रोकना अधिक लाभकारी होगा।'
        : 'Deductions are currently heavy and this crop has good shelf life — holding in dry storage can capture seasonal price recovery.';
    } else if (qty < 25) {
      action = 'pool';
      actionReason = state.lang === 'hi'
        ? 'आपकी मात्रा कम है (25 क्विंटल से कम) — माइक्रो-पूलिंग में जुड़ने से सामूहिक गाड़ी का भाड़ा बचेगा और बड़े खरीदार मिलेंगे।'
        : 'Your volume is under 25 quintals — joining a nearby micro-pool consolidates volume, saving transport and attracting bulk corporate buyers.';
    } else {
      action = 'sell';
      actionReason = state.lang === 'hi'
        ? 'आज का सर्वश्रेष्ठ नेट ऑफ़र आकर्षक है — अतिरिक्त इंतज़ार करने से भंडारण व मूल्य ह्रास का जोखिम बढ़ेगा।'
        : 'The top net offer provides excellent margin today — waiting introduces more holding risk than potential upside.';
    }

    state.calcResult = {
      crop: crop,
      qty: qty,
      grade: grade,
      options: all,
      best: all[0],
      action: action,
      actionReason: actionReason,
      wx: wx
    };
  }

  /* ============ SVG GRAPHICS HELPERS ============ */
  function logoMark(size) {
    size = size || 34;
    return '<svg class="mark" width="' + size + '" height="' + size + '" viewBox="0 0 40 40" fill="none" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="KrishiLink AI logo">'
      + '<circle cx="20" cy="20" r="19" stroke="currentColor" stroke-width="1.5" opacity="0.35"/>'
      + '<path d="M20 6C20 6 30 12 30 21C30 27.6 25.6 32 20 32C14.4 32 10 27.6 10 21C10 12 20 6 20 6Z" fill="var(--clr-accent)"/>'
      + '<path d="M20 12V29" stroke="var(--clr-primary-dark)" stroke-width="1.6" stroke-linecap="round" opacity="0.65"/>'
      + '<path d="M20 17L15 14" stroke="var(--clr-primary-dark)" stroke-width="1.4" stroke-linecap="round" opacity="0.55"/>'
      + '<path d="M20 21L25 18" stroke="var(--clr-primary-dark)" stroke-width="1.4" stroke-linecap="round" opacity="0.55"/>'
      + '</svg>';
  }

  function sparklineSVG(values, w, h) {
    w = w || 240; h = h || 64;
    const max = Math.max.apply(null, values);
    const min = Math.min.apply(null, values);
    const range = (max - min) || 1;
    const step = w / (values.length - 1);

    const pts = values.map(function (v, i) {
      return (i * step).toFixed(1) + ',' + (h - ((v - min) / range) * (h - 10) - 5).toFixed(1);
    });
    const last = pts[pts.length - 1].split(',');

    return '<svg width="' + w + '" height="' + h + '" viewBox="0 0 ' + w + ' ' + h + '" fill="none" aria-hidden="true">'
      + '<polyline points="' + pts.join(' ') + '" fill="none" stroke="var(--clr-primary)" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"/>'
      + '<circle cx="' + last[0] + '" cy="' + last[1] + '" r="4.5" fill="var(--clr-accent)"/>'
      + '</svg>';
  }

  /* ============ TIMER MANAGEMENT ============ */
  let activeTimers = [];
  function clearAllTimers() {
    activeTimers.forEach(function (id) { clearInterval(id); });
    activeTimers = [];
  }

  function startOfferTimers() {
    const id = setInterval(function () {
      let anyLeft = false;
      state.beaconOffers.forEach(function (o) {
        const remain = Math.max(0, o.expiresAt - Date.now());
        if (remain > 0) anyLeft = true;
        const el = document.querySelector('[data-timer-for="' + o.id + '"]');
        if (el) {
          const m = Math.floor(remain / 60000);
          const s = Math.floor((remain % 60000) / 1000);
          el.textContent = (m < 10 ? '0' : '') + m + ':' + (s < 10 ? '0' : '') + s;
        }
      });
      if (!anyLeft) clearInterval(id);
    }, 1000);
    activeTimers.push(id);
  }

  /* ============ RENDERING ENGINE ============ */
  function renderRoot() {
    const root = document.getElementById('app-root');
    document.documentElement.setAttribute('data-theme', state.theme === 'auto' ? '' : state.theme);
    clearAllTimers();

    let html = '<a class="skip-link" href="#main-content">' + t('skip_to_content') + '</a>';

    if (state.route === 'landing') html += renderLanding();
    else if (state.route === 'login') html += renderLogin();
    else if (state.route === 'legal') html += renderLegalPage();
    else html += renderApp();

    html += renderConsentBanner();
    root.innerHTML = html;
    afterRender();
  }

  function afterRender() {
    bindOtpBoxes();
    const log = document.getElementById('chatLog');
    if (log) log.scrollTop = log.scrollHeight;
    if (state.beaconStatus === 'live') startOfferTimers();
  }

  function bindOtpBoxes() {
    document.querySelectorAll('.otp-box').forEach(function (input) {
      input.addEventListener('input', function () {
        input.value = input.value.replace(/[^0-9]/g, '').slice(0, 1);
        if (input.value && input.nextElementSibling && input.nextElementSibling.classList.contains('otp-box')) {
          input.nextElementSibling.focus();
        }
      });
      input.addEventListener('keydown', function (e) {
        if (e.key === 'Backspace' && !input.value && input.previousElementSibling && input.previousElementSibling.classList.contains('otp-box')) {
          input.previousElementSibling.focus();
        }
      });
    });
  }

  /* ============ LANDING PAGE RENDER ============ */
  function renderLanding() {
    const sampleCrop = CROPS[2]; // Onion
    return '<div class="landing" id="main-content">'
      + '<header class="landing-header"><div class="wrap">'
        + '<div class="logo">' + logoMark(32) + '<div>KrishiLink AI<small>' + t('brand_sub') + '</small></div></div>'
        + '<nav class="landing-nav">'
          + '<a data-action="scrollto" data-target="features">' + t('nav_features') + '</a>'
          + '<a data-action="scrollto" data-target="how">' + t('nav_how') + '</a>'
          + '<a data-action="scrollto" data-target="faqsec">' + t('nav_faq') + '</a>'
        + '</nav>'
        + '<div class="header-actions">'
          + '<button class="chip ' + (state.lang === 'en' ? 'on' : '') + '" data-action="setlang" data-lang="en">EN</button>'
          + '<button class="chip ' + (state.lang === 'hi' ? 'on' : '') + '" data-action="setlang" data-lang="hi">हिं</button>'
          + '<button class="btn btn-ghost btn-sm" data-action="goto-login">' + t('login') + '</button>'
          + '<button class="btn btn-primary btn-sm" data-action="goto-login">' + t('get_started') + '</button>'
        + '</div>'
      + '</div></header>'

      + '<section class="hero"><div class="wrap hero-grid">'
        + '<div>'
          + '<div class="hero-eyebrow"><span class="badge badge-clay">SIH 2026 · PS #26132</span><span class="badge badge-green">Team AgroNEX</span></div>'
          + '<h1>' + t('hero_h1') + '</h1>'
          + '<p class="lede">' + t('hero_lede') + '</p>'
          + '<div class="hero-ctas">'
            + '<button class="btn btn-primary" data-action="goto-login">🚀 ' + t('hero_cta1') + '</button>'
            + '<button class="btn btn-ghost" data-action="scrollto" data-target="how">' + t('hero_cta2') + ' ↓</button>'
          + '</div>'
          + '<div class="hero-stats">'
            + '<div class="stat"><b>100%</b><span>' + t('stat1') + '</span></div>'
            + '<div class="stat"><b>5+</b><span>' + t('stat2') + '</span></div>'
            + '<div class="stat"><b>20 km</b><span>' + t('stat3') + '</span></div>'
          + '</div>'
        + '</div>'

        + '<div class="decision-preview">'
          + '<div class="dp-top"><div><div class="dp-crop">' + sampleCrop.icon + ' ' + cropName(sampleCrop) + ' · 20q</div><div class="dp-sub">Doaba Foods Ltd. · 27 km away</div></div><span class="badge badge-gold">' + t('best_option') + '</span></div>'
          + '<div class="dp-net-label">' + t('br_net') + '</div>'
          + '<div class="dp-price-row"><span class="dp-gross">' + fmtINR(sampleCrop.base * 20) + '</span><span class="dp-net">' + fmtINR(sampleCrop.base * 20 * 0.84) + '</span></div>'
          + '<div class="dp-breakdown">'
            + '<div><span>' + t('br_transport') + '</span><span>-' + fmtINR(sampleCrop.base * 20 * 0.04) + '</span></div>'
            + '<div><span>' + t('br_commission') + '</span><span>-' + fmtINR(sampleCrop.base * 20 * 0.035) + '</span></div>'
            + '<div><span>' + t('br_quality') + '</span><span>-' + fmtINR(sampleCrop.base * 20 * 0.02) + '</span></div>'
          + '</div>'
          + '<div class="dp-action"><span>🟢 ' + t('act_sell') + '</span><span>→</span></div>'
        + '</div>'
      + '</div></section>'

      + '<section class="problem-strip"><div class="wrap">'
        + '<div class="problem-item"><b>' + t('p1t') + '</b><span>' + t('p1s') + '</span></div>'
        + '<div class="problem-item"><b>' + t('p2t') + '</b><span>' + t('p2s') + '</span></div>'
        + '<div class="problem-item"><b>' + t('p3t') + '</b><span>' + t('p3s') + '</span></div>'
        + '<div class="problem-item"><b>' + t('p4t') + '</b><span>' + t('p4s') + '</span></div>'
      + '</div></section>'

      + '<section class="section" id="features"><div class="wrap">'
        + '<div class="section-head"><span class="kicker">' + t('feat_kicker') + '</span><h2>' + t('feat_h') + '</h2></div>'
        + '<div class="feature-grid">'
          + '<div class="feature-card"><div class="f-icon">🧮</div><h3>' + t('f1t') + '</h3><p>' + t('f1s') + '</p></div>'
          + '<div class="feature-card"><div class="f-icon">📡</div><h3>' + t('f2t') + '</h3><p>' + t('f2s') + '</p></div>'
          + '<div class="feature-card"><div class="f-icon">🤝</div><h3>' + t('f3t') + '</h3><p>' + t('f3s') + '</p></div>'
          + '<div class="feature-card"><div class="f-icon">🛡️</div><h3>' + t('f4t') + '</h3><p>' + t('f4s') + '</p></div>'
          + '<div class="feature-card"><div class="f-icon">🎙️</div><h3>' + t('f5t') + '</h3><p>' + t('f5s') + '</p></div>'
          + '<div class="feature-card"><div class="f-icon">🌦️</div><h3>' + t('f6t') + '</h3><p>' + t('f6s') + '</p></div>'
        + '</div>'
      + '</div></section>'

      + '<section class="section" id="how" style="background:var(--clr-surface-2)"><div class="wrap">'
        + '<div class="section-head"><span class="kicker">' + t('how_kicker') + '</span><h2>' + t('how_h') + '</h2></div>'
        + '<div class="steps-row">'
          + '<div class="step-item"><div class="step-line"></div><div class="snum">1</div><h4>' + t('s1t') + '</h4><p>' + t('s1s') + '</p></div>'
          + '<div class="step-item"><div class="step-line"></div><div class="snum">2</div><h4>' + t('s2t') + '</h4><p>' + t('s2s') + '</p></div>'
          + '<div class="step-item"><div class="step-line"></div><div class="snum">3</div><h4>' + t('s3t') + '</h4><p>' + t('s3s') + '</p></div>'
          + '<div class="step-item"><div class="step-line"></div><div class="snum">4</div><h4>' + t('s4t') + '</h4><p>' + t('s4s') + '</p></div>'
        + '</div>'
      + '</div></section>'

      + '<section class="section" id="faqsec"><div class="wrap">'
        + '<div class="section-head"><span class="kicker">' + t('nav_faq') + '</span><h2>' + t('faq_title') + '</h2></div>'
        + renderFaqList(FAQ_DATA.slice(0, 4), 'landing')
        + '<div style="margin-top:24px"><button class="btn btn-ghost" data-action="goto-login">' + t('view_all') + ' ' + t('nav_faq') + ' →</button></div>'
      + '</div></section>'

      + '<section class="section" style="padding-top:0"><div class="wrap">'
        + '<div class="final-cta">'
          + '<h2>' + t('cta_final_h') + '</h2>'
          + '<p>' + t('cta_final_p') + '</p>'
          + '<button class="btn btn-accent" data-action="goto-login">' + t('cta_final_btn') + '</button>'
        + '</div>'
      + '</div></section>'

      + '<footer class="landing-footer"><div class="wrap">'
        + '<div class="row-between" style="width:100%;flex-wrap:wrap;gap:16px">'
          + '<div class="logo">' + logoMark(28) + '<div>KrishiLink AI</div></div>'
          + '<div class="footer-links">'
            + '<button data-action="open-legal" data-legal="privacy">' + t('footer_privacy') + '</button>'
            + '<button data-action="open-legal" data-legal="terms">' + t('footer_terms') + '</button>'
            + '<button data-action="scrollto" data-target="faqsec">' + t('nav_faq') + '</button>'
          + '</div>'
        + '</div>'
        + '<span class="credit">' + t('footer_credit') + '</span>'
      + '</div></footer>'
    + '</div>';
  }

  /* ============ LOGIN / AUTH RENDER ============ */
  function renderLogin() {
    return '<div class="auth-shell">'
      + '<div class="auth-visual">'
        + '<div class="logo">' + logoMark(32) + '<div>KrishiLink AI<small style="color:rgba(251,248,239,.6)">' + t('brand_sub') + '</small></div></div>'
        + '<div class="auth-visual-quote"><p>' + t('auth_quote') + '</p></div>'
        + '<div class="auth-visual-foot"><span>🧮 ' + t('f1t') + '</span><span>📡 ' + t('f2t') + '</span><span>🛡️ ' + t('f4t') + '</span></div>'
      + '</div>'

      + '<div class="auth-main" id="main-content"><div class="auth-box">'
        + '<button class="btn btn-ghost btn-sm" style="margin-bottom:20px" data-action="goto-landing">← KrishiLink AI Home</button>'
        + '<h2>' + t('login_title') + '</h2><p style="margin-bottom:24px">' + t('login_sub') + '</p>'

        + '<div class="role-toggle">'
          + '<button class="' + (state.role === 'farmer' ? 'active' : '') + '" data-action="set-role" data-role="farmer">🌾 ' + t('role_farmer') + '</button>'
          + '<button class="' + (state.role === 'buyer' ? 'active' : '') + '" data-action="set-role" data-role="buyer">🏪 ' + t('role_buyer') + '</button>'
        + '</div>'

        + (state.loginStep === 'phone' ? renderLoginPhoneStep() : renderLoginOtpStep())

        + '<div class="lang-pills">'
          + '<button class="' + (state.lang === 'en' ? 'active' : '') + '" data-action="setlang" data-lang="en">English</button>'
          + '<button class="' + (state.lang === 'hi' ? 'active' : '') + '" data-action="setlang" data-lang="hi">हिंदी</button>'
          + '<span class="chip" style="opacity:.65">' + t('more_soon') + '</span>'
        + '</div>'

        + '<div class="footer-links" style="margin-top:26px">'
          + '<button data-action="open-legal" data-legal="privacy">' + t('footer_privacy') + '</button>'
          + '<button data-action="open-legal" data-legal="terms">' + t('footer_terms') + '</button>'
        + '</div>'
      + '</div></div>'
    + '</div>';
  }

  function renderLoginPhoneStep() {
    return '<form data-form="phone" novalidate>'
      + '<div class="field" data-field="phone">'
        + '<label for="phoneInput">' + t('phone_label') + '</label>'
        + '<input id="phoneInput" name="phone" type="tel" inputmode="numeric" maxlength="10" placeholder="' + t('phone_ph') + '" value="' + escapeHtml(state.loginPhone) + '" required>'
        + '<span class="field-error">' + t('err_phone') + '</span>'
      + '</div>'
      + '<div class="hp-field" aria-hidden="true"><label>Website<input type="text" name="website" tabindex="-1" autocomplete="off"></label></div>'
      + '<button type="submit" class="btn btn-primary btn-block">' + t('send_otp') + '</button>'
    + '</form>';
  }

  function renderLoginOtpStep() {
    return '<div class="row-between" style="margin-bottom:12px">'
      + '<span class="helptext">' + t('phone_label') + ': +91 ' + escapeHtml(state.loginPhone) + '</span>'
      + '<button class="btn btn-ghost btn-sm" data-action="change-number">' + t('change_number') + '</button>'
    + '</div>'
    + '<form data-form="otp" novalidate>'
      + '<div class="field" data-field="otp" style="margin-bottom:0">'
        + '<label>' + t('otp_label') + '</label>'
        + '<div class="otp-row">'
          + [0, 1, 2, 3].map(function (i) {
            return '<input class="otp-box" data-otp-idx="' + i + '" maxlength="1" inputmode="numeric" autocomplete="one-time-code">';
          }).join('')
        + '</div>'
        + '<span class="field-error">' + t('err_otp') + '</span>'
      + '</div>'
      + '<div class="demo-hint">💡 ' + t('demo_otp') + '</div>'
      + '<button type="submit" class="btn btn-primary btn-block" style="margin-top:18px">' + t('verify') + '</button>'
    + '</form>';
  }

  /* ============ APP SHELL & NAVIGATION ============ */
  const NAV_ITEMS = [
    { id: 'dashboard', ic: '🏠', key: 'nav_dashboard' },
    { id: 'sell',      ic: '🧮', key: 'nav_sell' },
    { id: 'beacon',    ic: '📡', key: 'nav_beacon' },
    { id: 'pooling',   ic: '🤝', key: 'nav_pooling' },
    { id: 'trust',     ic: '🛡️', key: 'nav_trust' },
    { id: 'weather',   ic: '🌦️', key: 'nav_weather' },
    { id: 'assistant', ic: '🎙️', key: 'nav_assistant' },
    { id: 'faq',       ic: '❓', key: 'nav_faq2' },
  ];
  const MOBILE_NAV = ['dashboard', 'sell', 'beacon', 'weather', 'assistant'];

  function renderApp() {
    const wx = genWeather(state.weatherRegion, 0);
    return '<div class="app-shell">'
      + '<aside class="sidebar">'
        + '<div class="logo">' + logoMark(30) + '<div>KrishiLink AI<small style="color:rgba(251,248,239,.6)">' + t('brand_sub') + '</small></div></div>'
        + '<ul class="nav-list">'
          + NAV_ITEMS.map(function (n) {
            return '<li><button class="' + (state.page === n.id ? 'active' : '') + '" data-action="goto-page" data-page="' + n.id + '"><span class="ic">' + n.ic + '</span>' + t(n.key) + '</button></li>';
          }).join('')
        + '</ul>'
        + '<div class="sidebar-foot">'
          + '<div class="mini-profile" data-action="goto-page" data-page="profile">'
            + '<div class="avatar">' + escapeHtml((state.user.name || 'F')[0]) + '</div>'
            + '<div class="who"><b>' + escapeHtml(state.user.name) + '</b><span>' + (state.role === 'farmer' ? t('role_farmer') : t('role_buyer')) + '</span></div>'
          + '</div>'
          + '<button class="btn btn-ghost btn-sm btn-block" style="margin-top:12px;color:rgba(251,248,239,.7)" data-action="logout">' + t('logout') + '</button>'
        + '</div>'
      + '</aside>'

      + '<div class="main-col">'
        + '<div class="topbar">'
          + '<h2>' + navTitle() + '</h2>'
          + '<div class="topbar-right">'
            + '<div class="weather-chip" data-action="goto-page" data-page="weather"><span>' + wx.cond.ic + '</span><span>' + wx.tempHigh + '°C · ' + escapeHtml(wx.regionName) + '</span></div>'
            + '<button class="chip ' + (state.lang === 'en' ? 'on' : '') + '" data-action="setlang" data-lang="en">EN</button>'
            + '<button class="chip ' + (state.lang === 'hi' ? 'on' : '') + '" data-action="setlang" data-lang="hi">हिं</button>'
            + '<button class="icon-btn" data-action="toggle-theme" title="Toggle Theme" aria-label="Toggle Theme">' + (state.theme === 'dark' ? '☀️' : '🌙') + '</button>'
          + '</div>'
        + '</div>'

        + '<div class="page-body" id="main-content">' + renderPage() + '</div>'
      + '</div>'

      + '<button class="assist-fab" data-action="goto-page" data-page="assistant" title="' + t('nav_assistant') + '" aria-label="' + t('nav_assistant') + '">🎙️</button>'

      + '<nav class="bottom-nav">'
        + MOBILE_NAV.map(function (id) {
          const n = NAV_ITEMS.find(function (x) { return x.id === id; });
          return '<button class="' + (state.page === id ? 'active' : '') + '" data-action="goto-page" data-page="' + id + '"><span class="ic">' + n.ic + '</span>' + t(n.key) + '</button>';
        }).join('')
      + '</nav>'

      + (state.showOtpModal ? renderOtpModal() : '')
      + (state.showAgreementModal ? renderAgreementModal() : '')
      + (state.selectedBuyerModal ? renderBuyerDetailModal() : '')
    + '</div>';
  }

  function navTitle() {
    const n = NAV_ITEMS.find(function (x) { return x.id === state.page; });
    if (state.page === 'profile') return t('nav_profile');
    return n ? t(n.key) : t('nf_title');
  }

  function renderPage() {
    switch (state.page) {
      case 'dashboard': return renderDashboard();
      case 'sell': return renderSell();
      case 'beacon': return renderBeacon();
      case 'pooling': return renderPooling();
      case 'trust': return renderTrust();
      case 'weather': return renderWeatherPage();
      case 'assistant': return renderAssistant();
      case 'faq': return renderFaqPage();
      case 'profile': return renderProfile();
      default: return renderNotFound();
    }
  }

  /* ============ DASHBOARD PAGE ============ */
  function renderDashboard() {
    const wx = genWeather(state.weatherRegion, 0);
    const advisory = harvestAdvisory(wx, CROPS[state.cropIdx]);
    const trend = [2180, 2210, 2265, 2240, 2300, 2330, 2350];
    const activity = [
      { t: state.lang === 'hi' ? 'Doaba Foods Ltd. ने 20q गेहूं पर ₹2,280/q का ऑफ़र दिया' : 'Doaba Foods Ltd. placed offer for 20q Wheat at ₹2,280/q', a: state.lang === 'hi' ? '2 घंटे पहले' : '2 hours ago' },
      { t: state.lang === 'hi' ? 'गाज़ियाबाद प्याज माइक्रो-पूल में 3 किसान जुड़े' : '3 farmers joined Ghaziabad Onion Micro-Pool', a: state.lang === 'hi' ? 'कल' : 'Yesterday' },
      { t: state.lang === 'hi' ? 'Anaaj Traders Co. के साथ डिजिटल एग्रीमेंट सत्यापित हुआ' : 'Digital Agreement completed with Anaaj Traders Co.', a: state.lang === 'hi' ? '3 दिन पहले' : '3 days ago' },
    ];

    return '<div class="stack">'
      + '<div><h3 style="margin-bottom:2px">' + t('greeting') + ', ' + escapeHtml(state.user.name.split(' ')[0]) + ' 👋</h3><p style="margin:0">' + t('dash_sub') + '</p></div>'

      + '<div class="advisory-banner"><span class="ic">' + advisory.icon + '</span><div><b>' + advisory.title + '</b><p>' + advisory.body + '</p></div></div>'

      + '<div class="grid-4">'
        + statCard(t('stat_lots'), '3', '+1 active', true)
        + statCard(t('stat_offers'), '5', '+2 today', true)
        + statCard(t('stat_net'), fmtINR(2185), '+4.2%', true)
        + statCard(t('stat_saved'), fmtINR(6400), '+18%', true)
      + '</div>'

      + '<div class="grid-2">'
        + '<div class="card">'
          + '<div class="section-title"><h3>' + t('price_trend') + '</h3></div>'
          + '<div class="spark-wrap">'
            + sparklineSVG(trend, 260, 70)
            + '<div><div style="font-family:var(--font-display);font-size:1.6rem;color:var(--clr-primary)">' + fmtINR(2350) + '</div><span class="badge badge-green">↑ 7.8% (7d)</span></div>'
          + '</div>'
        + '</div>'

        + '<div class="card">'
          + '<div class="section-title"><h3>' + t('quick_actions') + '</h3></div>'
          + '<div class="stack" style="gap:10px">'
            + '<button class="btn btn-soft btn-block" style="justify-content:flex-start" data-action="goto-page" data-page="beacon">📡 ' + t('qa_broadcast') + '</button>'
            + '<button class="btn btn-soft btn-block" style="justify-content:flex-start" data-action="goto-page" data-page="sell">🧮 ' + t('qa_check') + '</button>'
            + '<button class="btn btn-soft btn-block" style="justify-content:flex-start" data-action="goto-page" data-page="trust">🛡️ ' + t('qa_buyers') + '</button>'
          + '</div>'
        + '</div>'
      + '</div>'

      + '<div class="grid-2">'
        + '<div class="card">'
          + '<div class="section-title"><h3>' + t('recent_activity') + '</h3></div>'
          + activity.map(function (a) {
            return '<div class="activity-item"><span class="dot"></span><div><b>' + a.t + '</b><span>' + a.a + '</span></div></div>';
          }).join('')
        + '</div>'

        + '<div class="card">'
          + '<div class="section-title"><h3>' + t('weather_snapshot') + '</h3></div>'
          + '<div style="display:flex;align-items:center;gap:18px;margin-bottom:12px">'
            + '<span style="font-size:2.8rem">' + wx.cond.ic + '</span>'
            + '<div><div style="font-family:var(--font-display);font-size:1.8rem">' + wx.tempHigh + '°C</div><span style="font-size:.85rem;color:var(--clr-ink-faint)">' + wxName(wx.cond) + ' · ' + escapeHtml(wx.regionName) + '</span></div>'
          + '</div>'
          + '<button class="btn btn-ghost btn-sm btn-block" data-action="goto-page" data-page="weather">' + t('view_all') + ' →</button>'
        + '</div>'
      + '</div>'
    + '</div>';
  }

  function statCard(label, val, delta, up) {
    return '<div class="card card-tight stat-card"><span class="lbl">' + label + '</span><b>' + val + '</b><span class="delta ' + (up ? 'up' : 'down') + '">' + (up ? '▲' : '▼') + ' ' + delta + '</span></div>';
  }

  /* ============ SELL / CALCULATOR PAGE ============ */
  function renderSell() {
    return '<div class="stack">'
      + '<div><h3 style="margin-bottom:2px">' + t('calc_title') + '</h3><p style="margin:0">' + t('calc_sub') + '</p></div>'

      + '<div class="calc-grid">'
        + '<div class="card calc-form">'
          + '<form data-form="calc" novalidate>'
            + '<div class="field"><label>' + t('lbl_crop') + '</label><select name="crop">'
              + CROPS.map(function (c, i) {
                return '<option value="' + i + '" ' + (i === state.cropIdx ? 'selected' : '') + '>' + c.icon + ' ' + cropName(c) + ' (Base: ' + fmtINR(c.base) + '/q)</option>';
              }).join('')
            + '</select></div>'

            + '<div class="field-row">'
              + '<div class="field" data-field="qty"><label for="qtyInput">' + t('lbl_qty') + '</label><input id="qtyInput" type="number" name="qty" min="1" max="500" value="' + state.qty + '"><span class="field-error">' + t('err_qty') + '</span></div>'
              + '<div class="field"><label>' + t('lbl_location') + '</label><input type="text" name="location" value="' + escapeHtml(state.user.village) + '"></div>'
            + '</div'
            + '<div class="field"><label>' + t('lbl_grade') + '</label><div class="qgrade-row">'
              + ['A', 'B', 'C'].map(function (g) {
                return '<button type="button" class="' + (state.grade === g ? 'active' : '') + '" data-action="set-grade" data-grade="' + g + '">' + t('grade_' + g.toLowerCase()) + '</button>';
              }).join('')
            + '</div></div>'

            + '<button type="submit" class="btn btn-primary btn-block">' + t('lbl_calc') + '</button>'
          + '</form>'
        + '</div>'

        + '<div>' + (state.calcResult ? renderCalcResult() : renderCalcEmpty()) + '</div>'
      + '</div>'
    + '</div>';
  }

  function renderCalcEmpty() {
    return '<div class="card" style="text-align:center;padding:48px 24px">'
      + '<div style="font-size:2.8rem;margin-bottom:12px">🧮</div>'
      + '<h4 style="margin-bottom:6px">' + (state.lang === 'hi' ? 'डिजिटल ट्विन तैयार है' : 'Digital Twin Ready') + '</h4>'
      + '<p style="margin:0">' + (state.lang === 'hi' ? 'बाईं ओर फसल और मात्रा दर्ज करें और "असली नेट भाव निकालें" दबाएं।' : 'Input your crop and quantity on the left to compute live net realization breakdown.') + '</p>'
    + '</div>';
  }

  function renderCalcResult() {
    const r = state.calcResult;
    const actLabelKey = { sell: 'act_sell', store: 'act_store', pool: 'act_pool', transport: 'act_transport' }[r.action];

    return '<div class="stack">'
      + '<div class="decision-card">'
        + '<span class="dc-label">' + t('decision_h') + '</span>'
        + '<div class="dc-action">' + t(actLabelKey) + '</div>'
        + '<p>' + r.actionReason + '</p>'
      + '</div>'

      + '<div>'
        + '<div class="section-title"><h3>' + t('compare_h') + '</h3></div>'
        + r.options.map(function (o, i) {
          return renderOptionCard(o, i === 0);
        }).join('')
      + '</div>'
    + '</div>';
  }

  function renderOptionCard(o, isBest) {
    return '<div class="option-card ' + (isBest ? 'best' : '') + '">'
      + (isBest ? '<span class="best-tag">' + t('best_option') + '</span>' : '')
      + '<div class="option-top">'
        + '<div><h4>' + escapeHtml(o.name) + '</h4><span class="odist">' + o.distanceKm + ' km · ' + (o.isBuyer ? ('🛡️ ' + o.trustAvg.toFixed(1) + '/5 Verified Buyer') : '🏛️ APMC Mandi') + '</span></div>'
      + '</div>'
      + '<div class="option-gross">' + t('br_gross') + ': ' + fmtINR(o.gross) + '</div>'
      + '<div class="option-net">' + fmtINR(o.net) + '</div>'
      + '<div class="breakdown-list">'
        + '<div><span>' + t('br_transport') + '</span><span>-' + fmtINR(o.transport) + '</span></div>'
        + '<div><span>' + t('br_commission') + '</span><span>-' + fmtINR(o.commission) + '</span></div>'
        + '<div><span>' + t('br_quality') + '</span><span>-' + fmtINR(o.quality) + '</span></div>'
        + '<div><span>' + t('br_storage') + '</span><span>-' + fmtINR(o.storage) + '</span></div>'
        + '<div><span>' + t('br_risk') + '</span><span>-' + fmtINR(o.risk) + '</span></div>'
        + '<div class="total"><span>' + t('br_net') + '</span><span>' + fmtINR(o.net) + '</span></div>'
      + '</div>'
    + '</div>';
  }

  /* ============ BEACON / REVERSE AUCTION PAGE ============ */
  function renderBeacon() {
    const crop = CROPS[state.cropIdx];
    return '<div class="stack">'
      + '<div><h3 style="margin-bottom:2px">' + t('beacon_title') + '</h3><p style="margin:0">' + t('beacon_sub') + '</p></div>'

      + '<div class="card">'
        + '<div class="row-between" style="margin-bottom:14px;flex-wrap:wrap">'
          + '<div style="display:flex;align-items:center;gap:12px">'
            + '<span style="font-size:2rem">' + crop.icon + '</span>'
            + '<div><b>' + cropName(crop) + ' · ' + state.qty + ' Quintals</b><div class="helptext">' + t('lbl_grade') + ' ' + state.grade + ' · ' + escapeHtml(state.user.village) + '</div></div>'
          + '</div>'
          + (state.beaconStatus === 'idle' ? '<button class="btn btn-accent" data-action="broadcast">📡 ' + t('broadcast_btn') + '</button>' : '')
        + '</div>'

        + (state.beaconStatus === 'broadcasting' ? '<div class="advisory-banner"><span class="ic">📡</span><div><b>' + t('broadcasting') + '</b><p style="margin:4px 0 0">' + (state.lang === 'hi' ? 'सत्यापित खरीदार आपके लॉट का मूल्यांकन कर रहे हैं…' : 'Verified institutional buyers are computing bids for your lot specifications…') + '</p></div></div>' : '')

        + (state.beaconStatus === 'live' ? renderOffers() : '')
      + '</div>'
    + '</div>';
  }

  function renderOffers() {
    if (!state.beaconOffers.length) return '';
    return '<div style="margin-top:20px">'
      + '<div class="section-title"><h3>' + t('offers_h') + ' (' + state.beaconOffers.length + ')</h3></div>'
      + state.beaconOffers.slice().sort(function (a, b) { return b.net - a.net; }).map(function (o) {
        const trustAvg = (Object.values(o.buyer.trust).reduce(function (a, b) { return a + b; }, 0) / 5).toFixed(1);
        return '<div class="offer-row">'
          + '<div class="obadge">' + o.buyer.name.charAt(0) + '</div>'
          + '<div class="offer-main">'
            + '<div class="oname">' + escapeHtml(o.buyer.name) + ' <span class="badge badge-green" style="font-size:.65rem">Verified</span></div>'
            + '<div class="ometa">🛡️ ' + trustAvg + '/5 · ' + o.buyer.distanceKm + ' km away · ' + o.buyer.type + '</div>'
          + '</div>'
          + '<div class="offer-price"><b>' + fmtINR(o.net) + '</b><span>' + t('br_net') + '</span></div>'
          + '<span class="timer-pill" data-timer-for="' + o.id + '">--:--</span>'
          + '<button class="btn btn-primary btn-sm" data-action="accept-offer" data-offer="' + o.id + '">' + t('accept') + '</button>'
        + '</div>';
      }).join('')
    + '</div>';
  }

  function startBroadcast() {
    state.beaconStatus = 'broadcasting';
    trackEvent('broadcasts');
    renderRoot();

    setTimeout(function () {
      if (!state.calcResult) runCalculation();
      const crop = CROPS[state.cropIdx];
      const chosen = BUYERS.slice().sort(function () { return Math.random() - 0.5; }).slice(0, 4);

      state.beaconOffers = chosen.map(function (b, i) {
        const calc = calcForOption(crop, state.qty, state.grade, b, true);
        return {
          id: 'off' + i,
          buyer: b,
          net: calc.net,
          gross: calc.gross,
          expiresAt: Date.now() + (5 + i * 2) * 60000
        };
      });

      state.beaconStatus = 'live';
      renderRoot();
    }, 1200);
  }

  /* ============ MICRO-POOLING PAGE ============ */
  function renderPooling() {
    const pct = Math.min(100, Math.round(state.poolAmount / state.poolTarget * 100));
    const lots = [
      { name: state.lang === 'hi' ? 'सुरेश कुमार' : 'Suresh Kumar', qty: 10, dist: 2.1 },
      { name: state.lang === 'hi' ? 'गीता देवी' : 'Geeta Devi', qty: 12, dist: 3.4 },
      { name: state.lang === 'hi' ? 'मोहन लाल' : 'Mohan Lal', qty: 10, dist: 4.8 },
    ];

    return '<div class="stack">'
      + '<div><h3 style="margin-bottom:2px">' + t('pooling_title') + '</h3><p style="margin:0">' + t('pooling_sub') + '</p></div>'

      + '<div class="card">'
        + '<div class="row-between" style="margin-bottom:10px">'
          + '<span class="helptext" style="font-size:.9rem;font-weight:700">' + t('pool_target') + ': ' + state.poolTarget + ' Quintals</span>'
          + '<span class="helptext" style="font-size:.9rem;font-weight:700">' + t('pool_current') + ': ' + state.poolAmount + 'q</span>'
        + '</div>'
        + '<div class="progress-track"><div class="progress-fill" style="width:' + pct + '%"></div></div>'
        + '<div style="margin-top:10px;font-weight:800;color:var(--clr-primary);font-size:1.1rem">' + pct + '% Completed (' + (state.poolTarget - state.poolAmount) + 'q needed)</div>'
        + '<button class="btn ' + (state.joinedPool ? 'btn-soft' : 'btn-accent') + ' btn-block" style="margin-top:16px" data-action="join-pool" ' + (state.joinedPool ? 'disabled' : '') + '>'
          + (state.joinedPool ? '✅ ' + cropName(CROPS[state.cropIdx]) + ' ' + state.qty + 'q Pooled' : '🤝 ' + t('join_pool') + ' (+' + state.qty + 'q)')
        + '</button>'
      + '</div>'

      + '<div class="card">'
        + '<div class="section-title"><h3>' + t('nearby_lots') + '</h3></div>'
        + lots.map(function (l) {
          return '<div class="lot-row"><span>👤 ' + l.name + '</span><span>' + l.qty + 'q</span><span class="helptext">' + l.dist + ' km away</span></div>';
        }).join('')
        + (state.joinedPool ? '<div class="lot-row" style="color:var(--clr-primary);font-weight:700"><span>👤 ' + escapeHtml(state.user.name) + ' (' + (state.lang === 'hi' ? 'आप' : 'You') + ')</span><span>' + state.qty + 'q</span><span class="helptext">0 km</span></div>' : '')
      + '</div>'
    + '</div>';
  }

  /* ============ BUYER TRUST LEDGER PAGE ============ */
  function renderTrust() {
    return '<div class="stack">'
      + '<div><h3 style="margin-bottom:2px">' + t('trust_title') + '</h3><p style="margin:0">' + t('trust_sub') + '</p></div>'
      + '<div class="grid-3">'
        + BUYERS.map(function (b) { return renderBuyerCard(b); }).join('')
      + '</div>'
    + '</div>';
  }

  function renderBuyerCard(b) {
    const avg = (Object.values(b.trust).reduce(function (a, c) { return a + c; }, 0) / 5);
    const dims = [
      ['dim_payment', 'payment'],
      ['dim_quality', 'quality'],
      ['dim_integrity', 'integrity'],
      ['dim_pickup', 'pickup'],
      ['dim_dispute', 'dispute']
    ];

    return '<div class="buyer-card" data-action="open-buyer" data-buyer="' + b.id + '">'
      + '<div class="buyer-top">'
        + '<div><div class="bname">' + escapeHtml(b.name) + '</div><span class="helptext">' + b.distanceKm + ' km away · ' + b.type + '</span></div>'
        + '<div class="bscore">🛡️ ' + avg.toFixed(1) + '</div>'
      + '</div>'
      + dims.map(function (d) {
        return '<div class="trust-dim">'
          + '<span class="dlabel">' + t(d[0]) + '</span>'
          + '<div class="trust-bar"><i style="width:' + (b.trust[d[1]] / 5 * 100) + '%"></i></div>'
          + '<span class="dval">' + b.trust[d[1]].toFixed(1) + '</span>'
        + '</div>';
      }).join('')
      + '<div style="margin-top:12px;font-size:.78rem;color:var(--clr-primary);font-weight:700">Tap to inspect verified credentials →</div>'
    + '</div>';
  }

  function renderBuyerDetailModal() {
    const b = state.selectedBuyerModal;
    if (!b) return '';
    const avg = (Object.values(b.trust).reduce(function (a, c) { return a + c; }, 0) / 5).toFixed(1);

    return '<div class="modal-overlay" data-action="close-modal-bg"><div class="modal-box" onclick="event.stopPropagation()">'
      + '<div class="row-between" style="margin-bottom:12px">'
        + '<h3>🛡️ ' + escapeHtml(b.name) + '</h3>'
        + '<span class="badge badge-green">Verified</span>'
      + '</div>'
      + '<p style="margin-bottom:14px;font-size:.88rem">' + b.type + ' · ' + b.distanceKm + ' km from your farm gate</p>'
      + '<div class="breakdown-list">'
        + '<div><span>Trust Score</span><b>' + avg + ' / 5.0</b></div>'
        + '<div><span>GSTIN</span><b>' + b.gstin + '</b></div>'
        + '<div><span>Completed Trades</span><b>' + b.trades + ' lots</b></div>'
        + '<div><span>Default / Dispute Rate</span><b>0.0%</b></div>'
        + '<div><span>Payment Window</span><b>Direct DBT (Within 4 hours)</b></div>'
      + '</div>'
      + '<button class="btn btn-primary btn-block" style="margin-top:20px" data-action="close-modal">' + t('close') + '</button>'
    + '</div></div>';
  }

  /* ============ WEATHER & MAP PAGE ============ */
  function renderWeatherPage() {
    const region = REGIONS.find(function (r) { return r.id === state.weatherRegion; }) || REGIONS[0];
    const wx = genWeather(region.id, 0);
    const advisory = harvestAdvisory(wx, CROPS[state.cropIdx]);
    const days = state.lang === 'hi' ? ['आज', 'कल', 'परसों', '+3 दिन', '+4 दिन'] : ['Today', 'Tomorrow', '+2 Days', '+3 Days', '+4 Days'];

    let svgZones = '';
    REGIONS.forEach(function (r) {
      const rw = genWeather(r.id, 0);
      const active = r.id === state.weatherRegion;
      svgZones += '<g data-action="select-region" data-region="' + r.id + '" class="zone-shape" role="button" tabindex="0" aria-label="' + regionName(r) + ': ' + rw.tempHigh + '°C, ' + wxName(rw.cond) + '" style="opacity:' + (active ? 1 : 0.72) + '">'
        + '<path d="' + ZONE_PATHS[r.id] + '" fill="' + (active ? 'var(--clr-primary)' : 'var(--clr-sky)') + '" stroke="var(--clr-surface)" stroke-width="3"/>'
        + '<text x="' + r.x + '" y="' + (r.y - 6) + '" class="zone-label" text-anchor="middle">' + regionName(r) + '</text>'
        + '<text x="' + r.x + '" y="' + (r.y + 16) + '" class="zone-temp" text-anchor="middle">' + rw.cond.ic + ' ' + rw.tempHigh + '°</text>'
      + '</g>';
    });

    return '<div class="stack">'
      + '<div><h3 style="margin-bottom:2px">' + t('weather_title') + '</h3><p style="margin:0">' + t('weather_sub') + '</p></div>'

      + '<div class="weather-layout">'
        + '<div class="map-svg-wrap">'
          + '<svg viewBox="0 0 360 320" width="100%" aria-label="NCR district agriculture weather map">' + svgZones + '</svg>'
          + '<div class="helptext" style="text-align:center;margin-top:8px">👆 Tap on any district (Ghaziabad, Meerut, Noida, Hapur, Baghpat, Bulandshahr)</div>'
        + '</div>'

        + '<div class="stack" style="gap:16px">'
          + '<div class="card">'
            + '<div style="display:flex;align-items:center;gap:16px;margin-bottom:10px">'
              + '<span style="font-size:3rem">' + wx.cond.ic + '</span>'
              + '<div><div style="font-family:var(--font-display);font-size:2rem">' + wx.tempHigh + '°C</div><span class="helptext">' + wxName(wx.cond) + ' · ' + escapeHtml(region.en) + ' District</span></div>'
            + '</div>'
            + '<div class="wx-metric"><span>' + t('humidity') + '</span><b>' + wx.humidity + '%</b></div>'
            + '<div class="wx-metric"><span>' + t('wind') + '</span><b>' + wx.wind + ' km/h</b></div>'
            + '<div class="wx-metric"><span>' + t('rain_chance') + '</span><b>' + wx.rainChance + '%</b></div>'
          + '</div>'

          + '<div class="advisory-banner"><span class="ic">' + advisory.icon + '</span><div><b>' + advisory.title + '</b><p>' + advisory.body + '</p></div></div>'
        + '</div>'
      + '</div>'

      + '<div class="card">'
        + '<div class="section-title"><h3>' + t('forecast_5day') + ' (' + escapeHtml(region.en) + ')</h3></div>'
        + '<div class="forecast-strip">'
          + [0, 1, 2, 3, 4].map(function (i) {
            const d = genWeather(region.id, i);
            return '<div class="fday"><div class="fd-name">' + days[i] + '</div><div class="fd-ic">' + d.cond.ic + '</div><div class="fd-hi">' + d.tempHigh + '°</div><div class="fd-lo">' + d.tempLow + '°</div></div>';
          }).join('')
        + '</div>'
      + '</div>'
    + '</div>';
  }

  /* ============ FAQ PAGE ============ */
  function renderFaqPage() {
    const tabs = [
      ['all', 'tab_all'],
      ['farmers', 'tab_farmers'],
      ['buyers', 'tab_buyers'],
      ['trust', 'tab_trust'],
      ['tech', 'tab_tech']
    ];

    const filtered = FAQ_DATA.filter(function (f) {
      const tabOk = state.faqTab === 'all' || f.tab === state.faqTab;
      const q = state.faqQuery.trim().toLowerCase();
      const qOk = !q || (f.qEn + f.aEn + f.qHi + f.aHi).toLowerCase().indexOf(q) >= 0;
      return tabOk && qOk;
    });

    return '<div class="stack">'
      + '<div><h3 style="margin-bottom:2px">' + t('faq_title') + '</h3><p style="margin:0">' + t('faq_sub') + '</p></div>'

      + '<input type="text" data-bind="faq-search" placeholder="' + t('faq_search_ph') + '" value="' + escapeHtml(state.faqQuery) + '" style="max-width:440px">'

      + '<div class="faq-tabs">'
        + tabs.map(function (tb) {
          return '<button class="' + (state.faqTab === tb[0] ? 'active' : '') + '" data-action="faq-tab" data-tab="' + tb[0] + '">' + t(tb[1]) + '</button>';
        }).join('')
      + '</div>'

      + '<div class="card">'
        + (filtered.length ? renderFaqList(filtered, 'app') : '<p style="margin:0">' + (state.lang === 'hi' ? 'कोई परिणाम नहीं मिला।' : 'No matching questions found.') + '</p>')
      + '</div>'
    + '</div>';
  }

  function renderFaqList(items, ctx) {
    return items.map(function (f, i) {
      const key = ctx + '-' + i;
      const open = !!state.faqOpen[key];
      return '<div class="faq-item ' + (open ? 'open' : '') + '">'
        + '<div class="faq-q" data-action="toggle-faq" data-faqkey="' + key + '"><span>' + (state.lang === 'hi' ? f.qHi : f.qEn) + '</span><span class="plus">+</span></div>'
        + '<div class="faq-a"><p>' + (state.lang === 'hi' ? f.aHi : f.aEn) + '</p></div>'
      + '</div>';
    }).join('');
  }

  /* ============ AI VOICE ASSISTANT PAGE ============ */
  const SUGGESTED_QUESTIONS = {
    en: [
      'What is Net Realization?',
      'Should I sell or store today?',
      'How does Micro-Pooling work?',
      'How is Buyer Trust score measured?',
      'What is today\'s weather advisory?'
    ],
    hi: [
      'नेट रियलाइज़ेशन क्या है?',
      'आज फसल बेचूं या रोकूं?',
      'माइक्रो-पूलिंग कैसे काम करती है?',
      'बायर ट्रस्ट स्कोर कैसे आंका जाता है?',
      'आज की मौसम सलाह क्या है?'
    ]
  };

  function renderAssistant() {
    const suggested = SUGGESTED_QUESTIONS[state.lang] || SUGGESTED_QUESTIONS.en;
    if (state.chat.length === 0) {
      state.chat.push({ role: 'bot', text: t('chat_hi') });
    }

    return '<div class="stack">'
      + '<div><h3 style="margin-bottom:2px">' + t('assistant_title') + '</h3><p style="margin:0">' + t('assistant_sub') + '</p></div>'

      + '<div class="assistant-shell">'
        + '<div class="chat-col">'
          + '<div class="chat-log" id="chatLog">'
            + state.chat.map(function (m) {
              return '<div class="bubble ' + (m.role === 'user' ? 'user' : 'bot') + '">' + escapeHtml(m.text) + '</div>';
            }).join('')
            + (state.chatBusy ? '<div class="bubble bot typing"><span></span><span></span><span></span></div>' : '')
          + '</div>'

          + '<div class="chat-suggest">'
            + suggested.map(function (q) {
              return '<button data-action="ask-suggested" data-q="' + escapeHtml(q) + '">' + escapeHtml(q) + '</button>';
            }).join('')
          + '</div>'

          + '<form data-form="chat" class="chat-input-row">'
            + '<button type="button" class="mic-btn ' + (state.chatListening ? 'listening' : '') + '" data-action="toggle-mic" title="' + t('mic_hint') + '" aria-label="' + t('mic_hint') + '">🎤</button>'
            + '<input type="text" name="msg" placeholder="' + t('chat_ph') + '" autocomplete="off" aria-label="' + t('chat_ph') + '">'
            + '<div class="hp-field" aria-hidden="true"><label>Subject<input type="text" name="subject" tabindex="-1" autocomplete="off"></label></div>'
            + '<button type="submit" class="btn btn-primary">' + t('chat_send') + '</button>'
          + '</form>'
        + '</div>'

        + '<div class="stack" style="gap:16px">'
          + '<div class="card card-tight">'
            + '<b style="font-size:.88rem">🤖 ' + (state.lang === 'hi' ? 'सहायक स्थिति' : 'Assistant Status') + '</b>'
            + '<p style="margin:8px 0 0;font-size:.84rem">✅ ' + (state.lang === 'hi' ? 'AI सहायक सक्रिय है (हिंदी व अंग्रेज़ी समर्थित)।' : 'AI Assistant is online with local agricultural intelligence.') + '</p>'
          + '</div>'

          + '<div class="card card-tight">'
            + '<b style="font-size:.88rem">🌐 ' + t('lang_select') + '</b>'
            + '<div class="lang-pills" style="margin-top:10px">'
              + '<button class="' + (state.lang === 'en' ? 'active' : '') + '" data-action="setlang" data-lang="en">English</button>'
              + '<button class="' + (state.lang === 'hi' ? 'active' : '') + '" data-action="setlang" data-lang="hi">हिंदी</button>'
            + '</div>'
          + '</div>'

          + '<div class="card card-tight">'
            + '<b style="font-size:.88rem">💡 ' + (state.lang === 'hi' ? 'वॉइस टिप्स' : 'Voice Tips') + '</b>'
            + '<p style="margin:8px 0 0;font-size:.82rem">' + (state.lang === 'hi' ? 'माइक पर टैप करके बोलें, सहायक आपको जवाब बोलकर भी सुनाएगा।' : 'Tap the mic to speak. The assistant will read out the answer in your selected language.') + '</p>'
          + '</div>'
        + '</div>'
      + '</div>'
    + '</div>';
  }

  function getLocalAnswer(query) {
    const q = query.toLowerCase();
    const isHi = state.lang === 'hi';

    for (let i = 0; i < AI_KNOWLEDGE.length; i++) {
      const item = AI_KNOWLEDGE[i];
      for (let k = 0; k < item.keys.length; k++) {
        if (q.indexOf(item.keys[k]) >= 0) {
          return isHi ? item.hi : item.en;
        }
      }
    }

    return isHi
      ? 'मैं आपकी फसल के असली नेट भाव, मौसम सलाह, माइक्रो-पूलिंग या खरीदार ट्रस्ट स्कोर की जानकारी दे सकता हूं। कृपया ऊपर दिए गए सुझावों में से चुनें या स्पष्ट प्रश्न पूछें।'
      : 'I can assist you with true net price calculations, harvest timing, micro-pooling, or buyer trust ratings. Try asking one of the suggested prompts above!';
  }

  async function sendChatMessage(text) {
    if (!text || !text.trim()) return;
    text = text.trim();
    state.chat.push({ role: 'user', text: text });
    state.chatBusy = true;
    trackEvent('chats');
    renderRoot();

    setTimeout(function () {
      const reply = getLocalAnswer(text);
      state.chatBusy = false;
      state.chat.push({ role: 'bot', text: reply });
      renderRoot();
      speak(reply);
    }, 550);
  }

  /* ============ SPEECH SYNTHESIS & RECOGNITION ============ */
  let recognition = null;
  let speechSupported = false;

  function initSpeech() {
    const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SR) return;
    speechSupported = true;
    recognition = new SR();
    recognition.continuous = false;
    recognition.interimResults = false;

    recognition.onresult = function (e) {
      const text = e.results[0][0].transcript;
      state.chatListening = false;
      sendChatMessage(text);
    };
    recognition.onerror = function () {
      state.chatListening = false;
      renderRoot();
    };
    recognition.onend = function () {
      if (state.chatListening) {
        state.chatListening = false;
        renderRoot();
      }
    };
  }

  function toggleMic() {
    if (!speechSupported) {
      alert(state.lang === 'hi' ? 'इस ब्राउज़र में वॉइस इनपुट उपलब्ध नहीं है। कृपया टाइप करें।' : 'Voice recognition is not supported in this browser. Please type your query.');
      return;
    }
    if (state.chatListening) {
      recognition.stop();
      state.chatListening = false;
      renderRoot();
      return;
    }
    try {
      recognition.lang = state.lang === 'hi' ? 'hi-IN' : 'en-IN';
      recognition.start();
      state.chatListening = true;
      renderRoot();
    } catch (e) {
      console.warn("Mic start error:", e);
    }
  }

  function speak(text) {
    try {
      if (!window.speechSynthesis) return;
      window.speechSynthesis.cancel();
      const u = new SpeechSynthesisUtterance(text);
      u.lang = state.lang === 'hi' ? 'hi-IN' : 'en-IN';
      const voices = window.speechSynthesis.getVoices();
      const match = voices.find(function (v) { return v.lang === u.lang; }) || voices.find(function (v) { return v.lang && v.lang.indexOf(state.lang) === 0; });
      if (match) u.voice = match;
      window.speechSynthesis.speak(u);
    } catch (e) {}
  }

  /* ============ PROFILE & SETTINGS ============ */
  function renderProfile() {
    const a = state.analytics;
    return '<div class="stack" style="max-width:540px">'
      + '<div><h3 style="margin-bottom:2px">' + t('profile_title') + '</h3></div>'

      + '<div class="card">'
        + '<form data-form="profile" novalidate>'
          + '<div class="field" data-field="name">'
            + '<label for="pfName">' + (state.lang === 'hi' ? 'किसान का नाम' : 'Farmer Name') + '</label>'
            + '<input id="pfName" type="text" name="name" value="' + escapeHtml(state.user.name) + '">'
            + '<span class="field-error">' + t('err_name') + '</span>'
          + '</div>'
          + '<div class="field"><label>' + t('lbl_location') + '</label><input type="text" name="village" value="' + escapeHtml(state.user.village) + '"></div>'
          + '<div class="field"><label>' + t('phone_label') + '</label><input type="text" value="+91 ' + escapeHtml(state.loginPhone || state.user.phone) + '" disabled></div>'
          + '<div class="field"><label>' + t('notif_pref') + '</label><div class="lang-pills">'
            + '<span class="chip on">SMS Alerts</span><span class="chip on">WhatsApp</span><span class="chip">IVR Calls</span>'
          + '</div></div>'
          + '<button type="submit" class="btn btn-primary btn-block">' + t('save_changes') + '</button>'
        + '</form>'
      + '</div>'

      + '<div class="card card-tight">'
        + '<b style="font-size:.9rem">📊 ' + t('insights_title') + '</b>'
        + '<div class="grid-3" style="margin-top:14px">'
          + '<div class="stat-card"><span class="lbl">' + t('insights_views') + '</span><b>' + (a.views || 0) + '</b></div>'
          + '<div class="stat-card"><span class="lbl">' + t('insights_calcs') + '</span><b>' + (a.calcs || 0) + '</b></div>'
          + '<div class="stat-card"><span class="lbl">' + t('insights_broadcasts') + '</span><b>' + (a.broadcasts || 0) + '</b></div>'
          + '<div class="stat-card"><span class="lbl">' + t('insights_offers') + '</span><b>' + (a.offersAccepted || 0) + '</b></div>'
          + '<div class="stat-card"><span class="lbl">' + t('insights_chats') + '</span><b>' + (a.chats || 0) + '</b></div>'
        + '</div>'
        + '<p style="margin:14px 0 0;font-size:.76rem;color:var(--clr-ink-faint)">🔒 ' + t('insights_note') + '</p>'
      + '</div>'

      + '<div class="footer-links">'
        + '<button data-action="open-legal" data-legal="privacy">' + t('footer_privacy') + '</button>'
        + '<button data-action="open-legal" data-legal="terms">' + t('footer_terms') + '</button>'
      + '</div>'

      + '<button class="btn btn-ghost btn-block" data-action="logout">' + t('logout') + '</button>'
    + '</div>';
  }

  /* ============ MODALS: OTP & AGREEMENT ============ */
  function renderOtpModal() {
    return '<div class="modal-overlay" data-action="close-modal-bg"><div class="modal-box" onclick="event.stopPropagation()">'
      + '<h3>' + t('modal_confirm_title') + '</h3><p>' + t('modal_confirm_sub') + '</p>'
      + '<div class="otp-row">'
        + [0, 1, 2, 3].map(function (i) {
          return '<input class="otp-box" data-modal-otp-idx="' + i + '" maxlength="1" inputmode="numeric">';
        }).join('')
      + '</div>'
      + '<div style="display:flex;gap:12px;margin-top:20px">'
        + '<button class="btn btn-ghost btn-block" data-action="close-modal">' + t('close') + '</button>'
        + '<button class="btn btn-primary btn-block" data-action="confirm-otp">' + t('verify') + '</button>'
      + '</div>'
    + '</div></div>';
  }

  function renderAgreementModal() {
    const o = state.selectedOffer;
    const crop = CROPS[state.cropIdx];
    return '<div class="modal-overlay" data-action="close-modal-bg"><div class="modal-box" onclick="event.stopPropagation()">'
      + '<div style="text-align:center;font-size:2.4rem;margin-bottom:6px">✅</div>'
      + '<h3 style="text-align:center">' + t('agreement_ready') + '</h3>'
      + (o ? '<div class="breakdown-list" style="margin:16px 0">'
        + '<div><span>' + (state.lang === 'hi' ? 'खरीदार' : 'Buyer') + '</span><b>' + escapeHtml(o.buyer.name) + '</b></div>'
        + '<div><span>' + (state.lang === 'hi' ? 'फसल व मात्रा' : 'Crop & Quantity') + '</span><b>' + cropName(crop) + ' · ' + state.qty + 'q</b></div>'
        + '<div><span>' + (state.lang === 'hi' ? 'गुणवत्ता श्रेणी' : 'Quality Grade') + '</span><b>Grade ' + state.grade + '</b></div>'
        + '<div class="total"><span>' + t('br_net') + '</span><b>' + fmtINR(o.net) + '</b></div>'
      + '</div>' : '')
      + '<div style="display:flex;gap:12px">'
        + '<button class="btn btn-ghost btn-block" data-action="close-modal">' + t('close') + '</button>'
        + '<button class="btn btn-accent btn-block" data-action="download-agreement">⬇ ' + t('download_agreement') + '</button>'
      + '</div>'
    + '</div></div>';
  }

  function downloadAgreement() {
    const o = state.selectedOffer;
    const crop = CROPS[state.cropIdx];
    const contractId = 'KL-' + Math.floor(100000 + Math.random() * 900000);
    const text = "====================================================\n"
      + "   KRISHILINK AI — VERIFIED DIGITAL HARVEST AGREEMENT\n"
      + "   Smart India Hackathon 2026 · Team AgroNEX (PS #26132)\n"
      + "====================================================\n\n"
      + "Contract ID:       " + contractId + "\n"
      + "Date & Time:       " + new Date().toLocaleString('en-IN') + "\n"
      + "Farmer:            " + state.user.name + " (" + state.user.village + ")\n"
      + "Verified Buyer:    " + (o ? o.buyer.name : 'Institutional Buyer') + "\n"
      + "Buyer GSTIN:       " + (o ? o.buyer.gstin : 'N/A') + "\n"
      + "Buyer Trust Score: " + (o ? (Object.values(o.buyer.trust).reduce(function(a,b){return a+b;},0)/5).toFixed(1) : '4.5') + "/5.0\n\n"
      + "--- HARVEST LOT SPECIFICATIONS ---\n"
      + "Crop:              " + cropName(crop) + "\n"
      + "Quantity:          " + state.qty + " Quintals\n"
      + "Quality Grade:     Grade " + state.grade + "\n"
      + "Agreed Net Price:  " + (o ? fmtINR(o.net) : 'N/A') + "\n"
      + "Gross Value:       " + (o ? fmtINR(o.gross) : 'N/A') + "\n\n"
      + "--- SETTLEMENT & LOGISTICS ---\n"
      + "Pickup Mode:       Farm Gate Collection\n"
      + "Weighment:         Electronic Weighbridge Certified\n"
      + "Payment Method:    Instant DBT Bank Transfer upon Weighment\n"
      + "OTP Authorization: VERIFIED (Code 1234)\n\n"
      + "----------------------------------------------------\n"
      + "This is a digital agreement generated by KrishiLink AI.\n"
      + "For dispute resolution, reference Problem Statement #26132.\n"
      + "====================================================\n";

    try {
      const blob = new Blob([text], { type: 'text/plain;charset=utf-8' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = 'KrishiLink-Agreement-' + contractId + '.txt';
      document.body.appendChild(a);
      a.click();
      setTimeout(function () {
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
      }, 200);
    } catch (e) {
      console.warn("Download fallback error:", e);
    }
  }

  /* ============ LEGAL PAGES ============ */
  function renderLegalPage() {
    const key = state.legalPage === 'terms' ? 'terms' : 'privacy';
    const titleKey = key === 'terms' ? 'terms_title' : 'privacy_title';
    const sections = LEGAL_CONTENT[key];

    return '<div class="legal-shell" id="main-content">'
      + '<button class="btn btn-ghost btn-sm" data-action="legal-back">← ' + t('legal_back') + '</button>'
      + '<h1 style="margin-top:20px">' + t(titleKey) + '</h1>'
      + '<span class="updated">' + (state.lang === 'hi' ? 'संस्करण: स्मार्ट इंडिया हैकथॉन 2026 प्रोटोटाइप' : 'Version: Smart India Hackathon 2026 Prototype') + '</span>'
      + sections.map(function (s) {
        return '<h2>' + (state.lang === 'hi' ? s.hi : s.en) + '</h2><p>' + (state.lang === 'hi' ? s.hiBody : s.enBody) + '</p>';
      }).join('')
    + '</div>';
  }

  function renderNotFound() {
    return '<div class="notfound-wrap">'
      + '<div class="nf-mark">🌾🔍</div>'
      + '<h2>' + t('nf_title') + '</h2>'
      + '<p>' + t('nf_body') + '</p>'
      + '<button class="btn btn-primary" style="margin-top:16px" data-action="goto-page" data-page="dashboard">' + t('nf_cta') + '</button>'
    + '</div>';
  }

  function renderConsentBanner() {
    if (state.consentGiven) return '';
    return '<div class="consent-banner" role="dialog" aria-label="' + t('privacy_title') + '">'
      + '<p>🔒 ' + t('consent_text') + ' <button data-action="open-legal" data-legal="privacy" style="background:none;border:none;color:var(--clr-primary);font-weight:800;cursor:pointer;padding:0;font-size:inherit">' + t('consent_learn') + '</button></p>'
      + '<div class="cb-actions"><button class="btn btn-primary btn-sm" data-action="accept-consent">' + t('consent_accept') + '</button></div>'
    + '</div>';
  }

  /* ============ EVENT HANDLERS ============ */
  function showFieldError(formEl, fieldName, show) {
    const wrap = formEl.querySelector('[data-field="' + fieldName + '"]');
    if (wrap) wrap.classList.toggle('has-error', !!show);
  }

  function isHoneypotFilled(formEl) {
    const hp = formEl.querySelector('.hp-field input');
    return !!(hp && hp.value && hp.value.trim().length > 0);
  }

  function handleAction(action, el, evt) {
    switch (action) {
      case 'setlang':
        state.lang = el.dataset.lang;
        persist();
        renderRoot();
        break;

      case 'toggle-theme':
        state.theme = (state.theme === 'dark') ? 'light' : 'dark';
        persist();
        renderRoot();
        break;

      case 'goto-login':
        state.route = 'login';
        renderRoot();
        break;

      case 'goto-landing':
        state.route = 'landing';
        renderRoot();
        break;

      case 'scrollto': {
        const targetId = el.dataset.target;
        const node = document.getElementById(targetId);
        if (node) node.scrollIntoView({ behavior: 'smooth' });
        break;
      }

      case 'set-role':
        state.role = el.dataset.role;
        renderRoot();
        break;

      case 'change-number':
        state.loginStep = 'phone';
        renderRoot();
        break;

      case 'goto-page':
        state.page = el.dataset.page;
        trackEvent('views');
        persist();
        renderRoot();
        window.scrollTo(0, 0);
        break;

      case 'logout':
        state.authed = false;
        state.route = 'landing';
        state.loginStep = 'phone';
        state.loginPhone = '';
        persist();
        renderRoot();
        break;

      case 'open-legal':
        state.previousRoute = state.route;
        state.legalPage = el.dataset.legal;
        state.route = 'legal';
        renderRoot();
        window.scrollTo(0, 0);
        break;

      case 'legal-back':
        state.route = state.previousRoute || (state.authed ? 'app' : 'landing');
        renderRoot();
        break;

      case 'accept-consent':
        state.consentGiven = true;
        persist();
        renderRoot();
        break;

      case 'set-grade':
        state.grade = el.dataset.grade;
        renderRoot();
        break;

      case 'broadcast':
        startBroadcast();
        break;

      case 'accept-offer':
        state.selectedOffer = state.beaconOffers.find(function (o) { return o.id === el.dataset.offer; }) || null;
        state.showOtpModal = true;
        renderRoot();
        break;

      case 'close-modal':
        state.showOtpModal = false;
        state.showAgreementModal = false;
        state.selectedBuyerModal = null;
        renderRoot();
        break;

      case 'close-modal-bg':
        if (evt.target === el) {
          state.showOtpModal = false;
          state.showAgreementModal = false;
          state.selectedBuyerModal = null;
          renderRoot();
        }
        break;

      case 'confirm-otp': {
        const digits = Array.from(document.querySelectorAll('[data-modal-otp-idx]')).map(function (i) { return i.value; }).join('');
        if (digits.length < 4 && digits !== '1234') {
          alert(state.lang === 'hi' ? 'कृपया सही 4-अंकीय OTP (डेमो: 1234) दर्ज करें।' : 'Please enter 4-digit code (Demo: 1234).');
          return;
        }
        state.showOtpModal = false;
        state.showAgreementModal = true;
        trackEvent('offersAccepted');
        renderRoot();
        break;
      }

      case 'download-agreement':
        downloadAgreement();
        break;

      case 'join-pool':
        state.poolAmount += state.qty;
        state.joinedPool = true;
        persist();
        renderRoot();
        break;

      case 'open-buyer': {
        const b = BUYERS.find(function (x) { return x.id === el.dataset.buyer; });
        if (b) {
          state.selectedBuyerModal = b;
          renderRoot();
        }
        break;
      }

      case 'select-region':
        state.weatherRegion = el.dataset.region;
        renderRoot();
        break;

      case 'toggle-faq': {
        const k = el.dataset.faqkey;
        state.faqOpen[k] = !state.faqOpen[k];
        renderRoot();
        break;
      }

      case 'faq-tab':
        state.faqTab = el.dataset.tab;
        renderRoot();
        break;

      case 'ask-suggested':
        sendChatMessage(el.dataset.q);
        break;

      case 'toggle-mic':
        toggleMic();
        break;
    }
  }

  function handleSubmit(formName, formEl) {
    if (formName === 'phone') {
      if (isHoneypotFilled(formEl)) return;
      const phone = formEl.querySelector('[name="phone"]').value.trim();
      const valid = /^[0-9]{10}$/.test(phone);
      showFieldError(formEl, 'phone', !valid);
      if (!valid) return;
      state.loginPhone = phone;
      state.loginStep = 'otp';
      renderRoot();
      setTimeout(function () {
        const f = document.querySelector('.otp-box');
        if (f) f.focus();
      }, 50);
    } else if (formName === 'otp') {
      const now = Date.now();
      if (now - state.lastOtpSubmitAt < 500) return;
      state.lastOtpSubmitAt = now;
      const digits = Array.from(document.querySelectorAll('.otp-box')).map(function (i) { return i.value; }).join('');
      const valid = digits.length === 4 && /^[0-9]{4}$/.test(digits);
      showFieldError(formEl, 'otp', !valid);
      if (!valid) return;
      state.authed = true;
      state.route = 'app';
      state.page = 'dashboard';
      persist();
      renderRoot();
    } else if (formName === 'calc') {
      const qtyVal = Number(formEl.querySelector('[name="qty"]').value);
      const valid = Number.isFinite(qtyVal) && qtyVal >= 1 && qtyVal <= 500;
      showFieldError(formEl, 'qty', !valid);
      if (!valid) return;
      state.cropIdx = Number(formEl.querySelector('[name="crop"]').value);
      state.qty = qtyVal;
      state.user.village = formEl.querySelector('[name="location"]').value || state.user.village;
      runCalculation();
      trackEvent('calcs');
      renderRoot();
    } else if (formName === 'profile') {
      const nameVal = formEl.querySelector('[name="name"]').value.trim();
      showFieldError(formEl, 'name', !nameVal);
      if (!nameVal) return;
      state.user.name = nameVal;
      state.user.village = formEl.querySelector('[name="village"]').value || state.user.village;
      persist();
      alert(state.lang === 'hi' ? 'प्रोफ़ाइल सफलतापूर्वक सहेज ली गई!' : 'Profile updated successfully!');
      renderRoot();
    } else if (formName === 'chat') {
      if (isHoneypotFilled(formEl)) return;
      const now = Date.now();
      if (now - state.lastChatSentAt < 600) return;
      const input = formEl.querySelector('[name="msg"]');
      const val = input.value.trim();
      if (!val) return;
      state.lastChatSentAt = now;
      input.value = '';
      sendChatMessage(val);
    }
  }

  /* ============ GLOBAL EVENT LISTENERS ============ */
  document.addEventListener('click', function (e) {
    const actionEl = e.target.closest('[data-action]');
    if (!actionEl) return;
    handleAction(actionEl.dataset.action, actionEl, e);
  });

  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape' && (state.showOtpModal || state.showAgreementModal || state.selectedBuyerModal)) {
      state.showOtpModal = false;
      state.showAgreementModal = false;
      state.selectedBuyerModal = null;
      renderRoot();
      return;
    }
    if (e.key !== 'Enter' && e.key !== ' ') return;
    const actionEl = e.target.closest('[role="button"][data-action]');
    if (!actionEl) return;
    e.preventDefault();
    handleAction(actionEl.dataset.action, actionEl, e);
  });

  document.addEventListener('submit', function (e) {
    const formEl = e.target.closest('form[data-form]');
    if (!formEl) return;
    e.preventDefault();
    handleSubmit(formEl.dataset.form, formEl);
  });

  document.addEventListener('input', function (e) {
    if (e.target.dataset && e.target.dataset.bind === 'faq-search') {
      state.faqQuery = e.target.value;
      const caret = e.target.selectionStart;
      renderRoot();
      const again = document.querySelector('[data-bind="faq-search"]');
      if (again) {
        again.focus();
        try { again.setSelectionRange(caret, caret); } catch (err) {}
      }
    }
  });

  /* ============ INITIALIZATION ============ */
  loadState();
  renderRoot();
  initSpeech();
  if (window.speechSynthesis) {
    window.speechSynthesis.onvoiceschanged = function () {};
  }

})();
