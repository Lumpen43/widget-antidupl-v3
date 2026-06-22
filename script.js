define(["jquery"], function ($) {
  var CustomWidget = function () {
    var self = this,
      system = self.system(),
      langs = self.langs;

    // =============================================================
    // Хранилище полей контакта
    // =============================================================

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
    // Загрузка кастомных полей контакта
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
    // UI в карточке контакта
    // =============================================================

    function initCardUI() {
      var token = getToken();
      var settings = self.get_settings();
      var wCode = self.params.widget_code;
      var selectedFields = [];
      try { selectedFields = JSON.parse(settings.compare_fields || "[]"); } catch (e) {}

      console.log("[Антидубль] initCardUI: wCode=", wCode, "token=", token ? "есть" : "нет", "fields=", selectedFields.length);

      var html = '<div style="padding:12px 15px;font-size:13px;line-height:1.5;">';
      html += '<div style="font-weight:600;font-size:14px;margin-bottom:10px;color:#333;">' + langs.interface.scan_button + '</div>';

      if (!token) {
        html += '<p style="color:#888;font-size:12px;">' + langs.interface.no_token + '</p>';
      } else if (!selectedFields.length) {
        html += '<p style="color:#888;font-size:12px;">' + langs.interface.no_fields + '</p>';
      } else {
        html += '<div style="margin-bottom:8px;font-size:11px;color:#666;">Поля: ' + selectedFields.length + '</div>';
        html += '<button class="adu-scan" style="width:100%;padding:8px;font-size:13px;cursor:pointer;border:none;border-radius:4px;background:#4CAF50;color:#fff;">' +
          langs.interface.scan_button + '</button>';
      }
      html += '</div>';

      var $body = $();
      if (wCode) {
        $body = $(".card-widgets__widget-" + wCode + " .card-widgets__widget__body");
        console.log("[Антидубль] поиск по wCode:", $body.length);
      }
      if (!$body.length) {
        $body = $(".card-widgets__widget__body").first();
        console.log("[Антидубль] fallback body:", $body.length);
      }
      if (!$body.length) {
        $body = $("body");
        console.log("[Антидубль] fallback body сам:", $body.length, "iframe:", window !== window.top);
      }
      if ($body.length) {
        $body.html(html);
        console.log("[Антидубль] HTML вставлен");
      } else {
        console.error("[Антидубль] КОНТЕЙНЕР НЕ НАЙДЕН");
      }

      $(".adu-scan").off().on("click", function () { doScan($(this)); });
    }

    function doScan($btn) {
      var settings = self.get_settings();
      var selectedFields = [];
      try { selectedFields = JSON.parse(settings.compare_fields || "[]"); } catch (e) {}
      if (!selectedFields.length) { notify(langs.interface.no_fields, true); return; }
      $btn.prop("disabled", true).text(langs.interface.scanning);
      fetchAll("contacts").then(function (contacts) {
        $btn.prop("disabled", false).text(langs.interface.scan_button);
        var groups = findDuplicates(contacts, selectedFields);
        if (!groups.length) { notify(langs.interface.no_duplicates, false); return; }
        showMergeModal(groups);
      }).catch(function (err) {
        $btn.prop("disabled", false).text(langs.interface.scan_button);
        notify(langs.interface.error_occurred + ": " + (err.message || ""), true);
      });
    }

    function showMergeModal(groups) {
      var html =
        '<div class="adu-overlay" style="position:fixed;top:0;left:0;right:0;bottom:0;background:rgba(0,0,0,0.4);z-index:99998;"></div>' +
        '<div class="adu-modal" style="position:fixed;top:50%;left:50%;transform:translate(-50%,-50%);background:#fff;border-radius:8px;box-shadow:0 8px 32px rgba(0,0,0,0.2);z-index:99999;width:520px;max-height:80vh;overflow-y:auto;padding:24px;">' +
        '<h3 style="margin:0 0 16px;font-size:16px;">' + langs.interface.found_groups + ' ' + groups.length + '</h3>';
      groups.forEach(function (g, idx) {
        html += '<div style="border:1px solid #e0e0e0;border-radius:6px;padding:12px;margin-bottom:10px;background:#fafafa;">' +
          '<div style="font-weight:600;margin-bottom:8px;">Группа ' + (idx + 1) + ' (' + g.ids.length + ' конт.)</div>';
        g.contacts.forEach(function (c) {
          html += '<div style="padding:3px 8px;margin:2px 0;font-size:12px;border-left:3px solid ' +
            (c.id === g.master_id ? '#4CAF50;font-weight:bold;background:#e8f5e9' : '#ccc;background:#fff') +
            '">' + (c.name || "—") + ' (ID:' + c.id + ')' + (c.id === g.master_id ? ' ← ' + langs.interface.master_label : '') + '</div>';
        });
        html += '<button class="adu-mrg" data-idx="' + idx + '" style="margin-top:8px;padding:5px 14px;font-size:12px;cursor:pointer;background:#1976d2;color:#fff;border:none;border-radius:4px;">' +
          langs.interface.merge_btn + '</button></div>';
      });
      html += '<div style="text-align:right;margin-top:12px;padding-top:12px;border-top:1px solid #e0e0e0;">' +
        '<button class="adu-close" style="padding:8px 20px;border:1px solid #e0e0e0;border-radius:6px;background:#fff;cursor:pointer;font-size:13px;">' +
        langs.interface.close_btn + '</button></div></div>';
      $("body").append(html);
      $(".adu-close, .adu-overlay").on("click", function () { $(".adu-modal, .adu-overlay").remove(); });
      $(".adu-mrg").on("click", function () {
        var idx = parseInt($(this).data("idx")), $btn = $(this), $grp = $btn.closest("div");
        $btn.prop("disabled", true).text(langs.interface.scanning);
        var g = groups[idx], ids = g.ids.filter(function (id) { return id !== g.master_id; });
        mergeContacts(g.master_id, ids).then(function () {
          $btn.text("✅ " + langs.interface.merge_api_success);
          $grp.fadeOut(300);
          notify(langs.interface.merge_success, false);
        }).catch(function (err) {
          $btn.prop("disabled", false).text(langs.interface.merge_btn);
          notify(langs.interface.error_occurred + ": " + (err.message || ""), true);
        });
      });
    }

    // =============================================================
    // НАСТРОЙКИ — custom-поле по документации
    // =============================================================

    function initSettings($settings_body) {
      var wCode = self.params.widget_code;
      console.log("[Антидубль] settings: wCode=", wCode);

      // По документации:
      //   hidden input ID: <код_виджета>_custom  (name="compare_fields")
      //   div content ID: <код_виджета>_custom_content
      var $content = $settings_body.find("#" + wCode + "_custom_content");
      var $hidden = $settings_body.find('input[name="compare_fields"]');

      console.log("[Антидубль] custom content найден:", $content.length, " hidden:", $hidden.length);

      if (!$content.length) {
        // fallback — ищем в модалке
        $content = $settings_body.find(".widget_settings_block");
        console.log("[Антидубль] fallback widget_settings_block:", $content.length);
      }

      // Загружаем поля
      loadCustomFields().then(function (fields) {
        renderFieldCheckboxes($content, $hidden, fields);
      });
    }

    function renderFieldCheckboxes($container, $hidden, fields) {
      var settings = self.get_settings();
      var selected = [];
      try { selected = JSON.parse(settings.compare_fields || "[]"); } catch (e) {}

      var html = '<div style="margin:12px 0;padding:12px;border:1px solid #e0e0e0;border-radius:6px;background:#fafafa;">' +
        '<label style="display:block;font-weight:600;margin-bottom:8px;font-size:13px;">' +
        langs.settings.compare_fields + '</label>';

      fields.forEach(function (f) {
        var checked = selected.indexOf(f.id) !== -1;
        html += '<label style="display:block;margin:3px 0;font-size:13px;cursor:pointer;">' +
          '<input type="checkbox" class="adu-field-cb" value="' + f.id + '" ' +
          (checked ? 'checked' : '') + ' style="margin-right:6px;"> ' +
          f.name + (f.type === "custom" ? '' : '') +
          '</label>';
      });
      html += '</div>';

      // Вставляем HTML в контейнер custom-поля
      $container.html(html);

      // По документации: при изменении пишем JSON в hidden и триггерим change
      $container.on("change", ".adu-field-cb", function () {
        var vals = [];
        $container.find(".adu-field-cb:checked").each(function () { vals.push($(this).val()); });
        var json = JSON.stringify(vals);
        if ($hidden.length) {
          $hidden.val(json).trigger("change");
          console.log("[Антидубль] saved fields:", json);
        }
      });

      // Сразу сохраняем начальное состояние
      var initial = [];
      $container.find(".adu-field-cb:checked").each(function () { initial.push($(this).val()); });
      if ($hidden.length && initial.length) {
        $hidden.val(JSON.stringify(initial));
      }
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
      settings: function ($settings_body) {
        initSettings($settings_body);
        return true;
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
