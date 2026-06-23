define(["jquery"], function ($) {
  var CustomWidget = function () {
    var self = this,
      system = self.system(),
      langs = self.langs;

    self.contactFields = [];
    self.customFieldsLoaded = false;

    // =============================================================
    // API
    // =============================================================

    function getToken() {
      return (self.get_settings().api_token || "").trim();
    }

    function api(method, url, data) {
      var token = getToken();
      if (!token) return Promise.reject({ status: 0, message: "Нет токена" });
      var opts = {
        url: url,
        type: method,
        headers: { "Authorization": "Bearer " + token }
      };
      if (method === "POST" || method === "PATCH") {
        opts.contentType = "application/json";
        opts.data = JSON.stringify(data);
      }
      return new Promise(function (resolve, reject) {
        $.ajax(opts).done(resolve).fail(function (jqXHR) {
          reject({ status: jqXHR.status, message: jqXHR.statusText || "Ошибка", response: jqXHR.responseText });
        });
      });
    }

    function apiRetry(method, url, data, maxRetries) {
      maxRetries = maxRetries || 3;
      function attempt(n) {
        return api(method, url, data).catch(function (err) {
          var status = err.status || 0;
          if (n < maxRetries - 1 && (status === 429 || status >= 500 || status === 0)) {
            var delay = 1000 * (n + 1);
            return new Promise(function (res) { setTimeout(res, delay); }).then(function () {
              return attempt(n + 1);
            });
          }
          throw err;
        });
      }
      return attempt(0);
    }

    function fetchAll(endpoint) {
      var all = [];
      function load(url) {
        return apiRetry("GET", url).then(function (resp) {
          if (resp._embedded) {
            var keys = Object.keys(resp._embedded);
            if (keys.length) {
              var entities = resp._embedded[keys[0]];
              if (entities) all = all.concat(entities);
            }
          }
          if (resp._links && resp._links.next) return load(resp._links.next.href);
          return all;
        });
      }
      return load("/api/v4/" + endpoint + "?limit=250");
    }

    // =============================================================
    // Загрузка полей
    // =============================================================

    function loadCustomFields() {
      if (self.customFieldsLoaded && self.contactFields.length) return Promise.resolve(self.contactFields);
      return apiRetry("GET", "/api/v4/contacts/custom_fields?limit=250").then(function (resp) {
        self.customFieldsLoaded = true;
        self.contactFields = [
          { id: "phone", name: "Телефон", type: "system" },
          { id: "email", name: "Email", type: "system" },
          { id: "name", name: "Имя", type: "system" }
        ];
        if (resp._embedded && resp._embedded.custom_fields) {
          resp._embedded.custom_fields.forEach(function (f) {
            self.contactFields.push({ id: f.id + "", name: f.name, type: "custom", field_code: f.field_code || "" });
          });
        }
        return self.contactFields;
      }).catch(function () {
        self.customFieldsLoaded = true;
        self.contactFields = [
          { id: "phone", name: "Телефон", type: "system" },
          { id: "email", name: "Email", type: "system" },
          { id: "name", name: "Имя", type: "system" }
        ];
        return self.contactFields;
      });
    }

    // =============================================================
    // Нормализация
    // =============================================================

    function normalizePhone(raw) {
      if (!raw) return "";
      return raw.replace(/[^\d+]/g, "").replace(/^8/, "7").replace(/^\+?7/, "7").replace(/^7/, "7");
    }

    function getFieldValue(contact, fieldId) {
      if (fieldId === "phone") {
        var phones = [];
        if (contact.custom_fields_values) {
          contact.custom_fields_values.forEach(function (cf) {
            if (cf.field_code === "PHONE") {
              (cf.values || []).forEach(function (v) { if (v.value) phones.push(normalizePhone(v.value)); });
            }
          });
        }
        return phones;
      }
      if (fieldId === "email") {
        var emails = [];
        if (contact.custom_fields_values) {
          contact.custom_fields_values.forEach(function (cf) {
            if (cf.field_code === "EMAIL") {
              (cf.values || []).forEach(function (v) { if (v.value) emails.push(v.value.toLowerCase().trim()); });
            }
          });
        }
        return emails;
      }
      if (fieldId === "name") {
        return contact.name ? [contact.name.trim().toLowerCase()] : [];
      }
      var vals = [];
      if (contact.custom_fields_values) {
        contact.custom_fields_values.forEach(function (cf) {
          if (cf.id + "" === fieldId || cf.field_code === fieldId) {
            (cf.values || []).forEach(function (v) { if (v.value) vals.push(v.value.toString().trim().toLowerCase()); });
          }
        });
      }
      return vals;
    }

    // =============================================================
    // Поиск дубликатов
    // =============================================================

    function findDuplicates(contacts, selectedFields) {
      if (!selectedFields || !selectedFields.length) return [];
      var maps = {}, allIds = {};
      selectedFields.forEach(function (fid) { maps[fid] = {}; });
      contacts.forEach(function (c) {
        allIds[c.id] = c;
        selectedFields.forEach(function (fid) {
          var vals = getFieldValue(c, fid);
          if (!vals.length) return;
          var key = vals.slice().sort().join("||");
          if (!key) return;
          if (!maps[fid][key]) maps[fid][key] = [];
          if (maps[fid][key].indexOf(c.id) === -1) maps[fid][key].push(c.id);
        });
      });
      var processed = {}, groups = [];
      selectedFields.forEach(function (fid) {
        Object.keys(maps[fid]).forEach(function (key) {
          var ids = maps[fid][key].filter(function (id) { return !processed[id]; });
          if (ids.length < 2) return;
          ids.sort();
          ids.forEach(function (id) { processed[id] = true; });
          groups.push({ master_id: ids[0], ids: ids, contacts: ids.map(function (id) { return allIds[id]; }).filter(Boolean) });
        });
      });
      return groups;
    }

    function mergeContacts(masterId, ids) {
      var queue = ids.slice();
      function next(remaining) {
        if (remaining.length === 0) return Promise.resolve({ merged: ids.length });
        var sid = remaining.shift();
        return apiRetry("POST", "/api/v4/contacts/merge", { merge_id: masterId, secondary_id: sid }).then(function () {
          return next(remaining);
        });
      }
      return next(queue);
    }

    function notify(msg, isErr) {
      var $n = $('<div style="position:fixed;top:20px;right:20px;z-index:99999;padding:12px 20px;border-radius:6px;font-size:14px;box-shadow:0 4px 12px rgba(0,0,0,0.15);max-width:400px;"></div>');
      $n.css("background", isErr ? "#ffebee" : "#e8f5e9");
      $n.css("color", isErr ? "#c62828" : "#2e7d32");
      $n.css("border", isErr ? "1px solid #ef9a9a" : "1px solid #a5d6a7");
      $n.text(msg);
      $("body").append($n);
      setTimeout(function () { $n.fadeOut(300, function () { $n.remove(); }); }, 4000);
    }

    // =============================================================
    // Карточка контакта
    // =============================================================

    function initCardUI() {
      console.log("[Антидубль] initCardUI called");
      try {
        var Ln2 = (langs && typeof langs === "object") ? langs : {};
        var L2 = {
          scan_button: (Ln2.interface && Ln2.interface.scan_button) || "Найти дубликаты",
          no_token: (Ln2.interface && Ln2.interface.no_token) || "Сначала настройте виджет",
          no_fields: (Ln2.interface && Ln2.interface.no_fields) || "Выберите поля в настройках",
          scanning: (Ln2.interface && Ln2.interface.scanning) || "Сканирование...",
          no_duplicates: (Ln2.interface && Ln2.interface.no_duplicates) || "Дубликаты не найдены",
          error_occurred: (Ln2.interface && Ln2.interface.error_occurred) || "Ошибка",
          found_groups: (Ln2.interface && Ln2.interface.found_groups) || "Найдено групп:",
          master_label: (Ln2.interface && Ln2.interface.master_label) || "главный",
          merge_btn: (Ln2.interface && Ln2.interface.merge_btn) || "Слить",
          close_btn: (Ln2.interface && Ln2.interface.close_btn) || "Закрыть",
          merge_api_success: (Ln2.interface && Ln2.interface.merge_api_success) || "Готово",
          merge_success: (Ln2.interface && Ln2.interface.merge_success) || "Слияние выполнено"
        };
        var lsKey = "adu3_" + (self.params && self.params.widget_code ? self.params.widget_code : "default");
        var settings = self.get_settings();
        console.log("[Антидубль] card get_settings:", JSON.stringify(settings));
        try {
          var lsData = JSON.parse(localStorage.getItem(lsKey) || "{}");
          if (lsData.api_token && !settings.api_token) settings.api_token = lsData.api_token;
          if (lsData.compare_fields && !settings.compare_fields) settings.compare_fields = lsData.compare_fields;
        } catch(e) {}
        var token = (settings.api_token || "").trim();
        var wCode = self.params.widget_code;
        console.log("[Антидубль] widget_code:", wCode);
        var selectedFields = [];
        try { selectedFields = JSON.parse(settings.compare_fields || "[]"); } catch (e) {}
        console.log("[Антидубль] card: wCode=", wCode, "token=", token ? "да" : "нет", "fields=", selectedFields.length);

        // Ищем .adu-card-body внутри нашего виджета в карточке
        // amoCRM сам рендерит widget.twig в контейнер виджета
        var $body = $();
        // Сначала по widget_code
        if (wCode) {
          $body = $(".card-widgets__widget-" + wCode + " .adu-card-body, .card-widgets__widget-" + wCode + " .adu-card-body").first();
        }
        // Если не нашли - ищем любой .adu-card-body внутри виджетов
        if (!$body || !$body.length) {
          $body = $(".card-widgets__widget__body .adu-card-body").first();
        }
        // Последний шанс - .adu-card-body вообще где угодно
        if (!$body || !$body.length) {
          $body = $(".adu-card-body").first();
        }
        if (!$body || !$body.length) {
          console.error("[Антидубль] .adu-card-body не найден в DOM");
          return;
        }
        console.log("[Антидубль] .adu-card-body найден");

        // Обновляем содержимое тела карточки (НЕ заменяем весь контейнер)
        var html = "";
        if (!token) {
          html = '<p style="color:#888;font-size:12px;">' + L2.no_token + '</p>';
        } else if (!selectedFields.length) {
          html = '<p style="color:#888;font-size:12px;">' + L2.no_fields + '</p>';
        } else {
          html = '<button class="adu-scan" style="width:100%;padding:9px;font-size:13px;cursor:pointer;border:none;border-radius:4px;background:#4CAF50;color:#fff;">' +
            L2.scan_button + '</button>';
        }
        $body.html(html);

        // Вешаем обработчик на кнопку сканирования
        if (token && selectedFields.length) {
          $(".adu-scan").off().on("click", function () { doScan($(this)); });
        }
    } catch(e) { console.error("[Антидубль] card UI error:", e); }
    }

    function doScan($btn) {
      var settings = self.get_settings();
      var selectedFields = [];
      try { selectedFields = JSON.parse(settings.compare_fields || "[]"); } catch (e) {}
      if (!selectedFields.length) { notify(L2.no_fields, true); return; }
      $btn.prop("disabled", true).text(L2.scanning);
      fetchAll("contacts").then(function (contacts) {
        $btn.prop("disabled", false).text(L2.scan_button);
        var groups = findDuplicates(contacts, selectedFields);
        if (!groups.length) { notify(L2.no_duplicates, false); return; }
        showMergeModal(groups);
      }).catch(function (err) {
        $btn.prop("disabled", false).text(L2.scan_button);
        notify(L2.error_occurred + ": " + (err.message || ""), true);
      });
    }

    function showMergeModal(groups) {
      var html =
        '<div class="adu-overlay" style="position:fixed;top:0;left:0;right:0;bottom:0;background:rgba(0,0,0,0.4);z-index:99998;"></div>' +
        '<div class="adu-modal" style="position:fixed;top:50%;left:50%;transform:translate(-50%,-50%);background:#fff;border-radius:8px;box-shadow:0 8px 32px rgba(0,0,0,0.2);z-index:99999;width:520px;max-height:80vh;overflow-y:auto;padding:24px;">' +
        '<h3 style="margin:0 0 16px;font-size:16px;">' + L2.found_groups + ' ' + groups.length + '</h3>';
      groups.forEach(function (g, idx) {
        html += '<div style="border:1px solid #e0e0e0;border-radius:6px;padding:12px;margin-bottom:10px;background:#fafafa;">' +
          '<div style="font-weight:600;margin-bottom:8px;">Группа ' + (idx + 1) + ' (' + g.ids.length + ' конт.)</div>';
        g.contacts.forEach(function (c) {
          html += '<div style="padding:3px 8px;margin:2px 0;font-size:12px;border-left:3px solid ' +
            (c.id === g.master_id ? '#4CAF50;font-weight:bold;background:#e8f5e9' : '#ccc;background:#fff') +
            '">' + (c.name || "—") + ' (ID:' + c.id + ')' + (c.id === g.master_id ? ' ← ' + L2.master_label : '') + '</div>';
        });
        html += '<button class="adu-mrg" data-idx="' + idx + '" style="margin-top:8px;padding:5px 14px;font-size:12px;cursor:pointer;background:#1976d2;color:#fff;border:none;border-radius:4px;">' +
          L2.merge_btn + '</button></div>';
      });
      html += '<div style="text-align:right;margin-top:12px;padding-top:12px;border-top:1px solid #e0e0e0;">' +
        '<button class="adu-close" style="padding:8px 20px;border:1px solid #e0e0e0;border-radius:6px;background:#fff;cursor:pointer;font-size:13px;">' +
        L2.close_btn + '</button></div></div>';
      $("body").append(html);
      $(".adu-close, .adu-overlay").on("click", function () { $(".adu-modal, .adu-overlay").remove(); });
      $(".adu-mrg").on("click", function () {
        var idx = parseInt($(this).data("idx")), $btn = $(this), $grp = $btn.closest("div");
        $btn.prop("disabled", true).text(L2.scanning);
        var g = groups[idx], ids = g.ids.filter(function (id) { return id !== g.master_id; });
        mergeContacts(g.master_id, ids).then(function () {
          $btn.text("✅ " + L2.merge_api_success);
          $grp.fadeOut(300);
          notify(L2.merge_success, false);
        }).catch(function (err) {
          $btn.prop("disabled", false).text(L2.merge_btn);
          notify(L2.error_occurred + ": " + (err.message || ""), true);
        });
      });
    }

    // =============================================================
    // СТРАНИЦА НАСТРОЕК (advanced_settings)
    // Полный контроль над страницей по документации
    // =============================================================

    function initAdvancedSettings() {
      console.log("[Антидубль] advancedSettings called");
      try {
        var settings = self.get_settings();
        console.log("[Антидубль] get_settings:", JSON.stringify(settings));
        // Backup из localStorage
        var lsKey = "adu3_" + (self.params && self.params.widget_code ? self.params.widget_code : "default");
        try {
          var lsData = JSON.parse(localStorage.getItem(lsKey) || "{}");
          if (lsData.api_token && !settings.api_token) settings.api_token = lsData.api_token;
          if (lsData.compare_fields && !settings.compare_fields) settings.compare_fields = lsData.compare_fields;
        } catch(e) {}
        var selectedFields = [];
        try { selectedFields = JSON.parse(settings.compare_fields || "[]"); } catch (e) {}
      // Fallback для langs (на странице advanced_settings может не быть)
      var Ln = (langs && typeof langs === "object") ? langs : {};
      var L = {
        advanced: { title: (Ln.advanced && Ln.advanced.title) || "Антидубль" },
        settings: {
          api_token: (Ln.settings && Ln.settings.api_token) || "Долгосрочный токен",
          compare_fields: (Ln.settings && Ln.settings.compare_fields) || "Поля для сравнения",
          save_btn: (Ln.settings && Ln.settings.save_btn) || "Сохранить"
        }
      };

      var html =
        '<div class="adu-adv-settings" style="max-width:600px;margin:20px auto;padding:24px;background:#fff;border-radius:8px;box-shadow:0 1px 4px rgba(0,0,0,0.1);">' +
        '<h2 style="margin:0 0 20px;font-size:18px;color:#333;">' + L.advanced.title + '</h2>' +

        // Токен
        '<div style="margin-bottom:16px;">' +
        '<label style="display:block;font-weight:600;margin-bottom:4px;font-size:13px;">' + L.settings.api_token + '</label>' +
        '<input type="text" id="adu-token" value="' + htmlEscape(settings.api_token || "") + '" ' +
        'style="width:100%;padding:8px;border:1px solid #ccc;border-radius:4px;font-size:13px;box-sizing:border-box;">' +
        '</div>' +

        // Поля для сравнения
        '<div style="margin-bottom:16px;">' +
        '<label style="display:block;font-weight:600;margin-bottom:8px;font-size:13px;">' + L.settings.compare_fields + '</label>' +
        '<div id="adu-fields-container" style="border:1px solid #e0e0e0;border-radius:6px;padding:12px;max-height:300px;overflow-y:auto;">' +
        '<p style="color:#888;font-size:12px;">Загрузка полей...</p>' +
        '</div></div>' +

        // Кнопка сохранения
        '<button id="adu-save-btn" style="padding:10px 24px;background:#4CAF50;color:#fff;border:none;border-radius:4px;font-size:14px;cursor:pointer;">' +
        L.settings.save_btn + '</button>' +
        '<span id="adu-status" style="margin-left:12px;font-size:13px;"></span>' +
        '</div>';

      // По документации: страница полностью контролируется виджетом
      // Ищем контейнер с fallback
      var $container = $("#list_page_holder").length ? $("#list_page_holder") : $("body");
      if ($container.is("body") || !$container.length) {
        $container = $(".content-container, .content-wrapper, .page-content, #content, body").first();
      }
      $container.html(html).show();

      // Загружаем поля и рендерим чекбоксы
      loadCustomFields().then(function (fields) {
        renderAdvCheckboxes(fields, selectedFields);
      });

      // Кнопка "Сохранить"
      $("#adu-save-btn").on("click", function () {
        var token = $("#adu-token").val().trim();
        var checked = [];
        $("#adu-fields-container .adu-field-cb:checked").each(function () {
          checked.push($(this).val());
        });
        var saveData = {
          api_token: token,
          compare_fields: JSON.stringify(checked)
        };
        // Сохраняем в localStorage (надежно)
        try {
          var lsKey = "adu3_" + (self.params && self.params.widget_code ? self.params.widget_code : "default");
          localStorage.setItem(lsKey, JSON.stringify(saveData));
        } catch(e) { console.error("[Антидубль] localStorage error:", e); }
        // Сохраняем через set_settings
        self.set_settings(saveData);
        console.log("[Антидубль] saved:", JSON.stringify(saveData));
        $("#adu-status").text("✅ Сохранено").fadeOut(2000, function () { $(this).show().text(""); });
      });
    } catch(e) { console.error("[Антидубль] advanced settings error:", e); }
    }

    function renderAdvCheckboxes(fields, selected) {
      var html = "";
      fields.forEach(function (f) {
        var checked = selected.indexOf(f.id) !== -1;
        html += '<label style="display:block;margin:3px 0;font-size:13px;cursor:pointer;padding:2px 4px;border-radius:3px;">' +
          '<input type="checkbox" class="adu-field-cb" value="' + f.id + '" ' +
          (checked ? 'checked' : '') + ' style="margin-right:6px;"> ' +
          f.name +
          '</label>';
      });
      if (!fields.length) {
        html = '<p style="color:#888;font-size:12px;">Нет доступных полей. Сначала введите токен.</p>';
      }
      $("#adu-fields-container").html(html);
    }

    function htmlEscape(str) {
      return str.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
    }

    // =============================================================
    // Callbacks
    // =============================================================

    this.callbacks = {
      render: function () {
        if (system.area === "ccard") {
          if (APP && APP.data && APP.data.current_card && APP.data.current_card.id === 0) return false;
          initCardUI();
        }
        return true;
      },
      init: function () {
        if (getToken()) loadCustomFields().catch(function () {});
        return true;
      },
      bind_actions: function () { return true; },
      settings: function () { return true; },
      advancedSettings: function () {
        initAdvancedSettings();
      },
      onSave: function () { return true; },
      destroy: function () {},
      contacts: { selected: function () {} },
      leads: { selected: function () {} },
      todo: { selected: function () {} }
    };

    return this;
  };
  return CustomWidget;
});