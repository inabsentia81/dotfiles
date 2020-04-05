// ----------------------------------------------------------------------------------------------------------------- //

// Nano Core 2 - An adblocker
// Copyright (C) 2018-2019  Nano Core 2 contributors
//
// This program is free software: you can redistribute it and/or modify
// it under the terms of the GNU General Public License as published by
// the Free Software Foundation, either version 3 of the License, or
// (at your option) any later version.
//
// This program is distributed in the hope that it will be useful,
// but WITHOUT ANY WARRANTY; without even the implied warranty of
// MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
// GNU General Public License for more details.
//
// You should have received a copy of the GNU General Public License
// along with this program.  If not, see <http://www.gnu.org/licenses/>.

// ----------------------------------------------------------------------------------------------------------------- //

// Dashboard my filters tab script

// ----------------------------------------------------------------------------------------------------------------- //

"use strict";

// ----------------------------------------------------------------------------------------------------------------- //

var nano = nano || {};

// ----------------------------------------------------------------------------------------------------------------- //

nano.filters_cache = "";

nano.editor = new nano.Editor("userFilters", true, false);

nano.has_unsaved_changes = false;

// ----------------------------------------------------------------------------------------------------------------- //

window.hasUnsavedData = () => {
    return nano.has_unsaved_changes;
};

// ----------------------------------------------------------------------------------------------------------------- //

nano.load_settings = async () => {
    const wrap = await vAPI.messaging.send("dashboard", {
        what: "userSettings",
        name: "nanoEditorSoftWrap",
    });

    nano.editor.set_line_wrap(wrap === true);
    nano.render_filters(true);
};

// ----------------------------------------------------------------------------------------------------------------- //

nano.render_filters = async (first) => {
    const details = await vAPI.messaging.send("dashboard", {
        what: "readUserFilters",
    });

    if (details instanceof Object === false || details.error)
        return;

    let content = details.content.trim();

    nano.filters_cache = content;

    if (content.length > 0)
        content += "\n";
    nano.editor.set_value_focus(content);

    nano.filters_changed(false);
    nano.render_anno();

    // TODO: Clear undo history if first is true?
};

nano.render_anno = async () => {
    const data = await vAPI.messaging.send("dashboard", {
        what: "nanoGetFilterLinterResult",
    });

    if (data)
        nano.editor.set_anno(data.errors.concat(data.warnings));
};

// ----------------------------------------------------------------------------------------------------------------- //

nano.filters_changed = (changed) => {
    if (typeof changed !== "boolean")
        changed = nano.editor.get_unix_value().trim() !== nano.filters_cache;

    const apply_disable = (id, disabled) => {
        const elem = document.getElementById(id);
        if (disabled)
            elem.setAttribute("disabled", "");
        else
            elem.removeAttribute("disabled");
    };

    apply_disable("userFiltersApply", !changed);
    apply_disable("userFiltersRevert", !changed);

    nano.has_unsaved_changes = changed;
};

nano.filters_saved = () => {
    vAPI.messaging.send("dashboard", {
        what: "reloadAllFilters",
    });

    const btn = document.getElementById("userFiltersApply");
    btn.setAttribute("disabled", "");

    // Wait a bit for filters to finish compiling
    setTimeout(nano.render_anno, 1000);
};

nano.filters_apply = async () => {
    const details = await vAPI.messaging.send("dashboard", {
        what: "writeUserFilters",
        content: nano.editor.get_unix_value(),
    });

    if (details instanceof Object === false || details.error)
        return;

    nano.filters_cache = details.content.trim();
    nano.editor.set_value_focus(details.content);

    nano.filters_changed(false);
    nano.filters_saved();

    // TODO: Set the cursor back to its original position?
    // TODO: Clear undo history?
};

nano.filters_revert = () => {
    let content = nano.filters_cache;

    if (content.length > 0)
        content += "\n";

    nano.editor.set_value_focus(content);
    nano.filters_changed(false);
};

// ----------------------------------------------------------------------------------------------------------------- //

nano.import_picked = function () {
    const abp_importer = (s) => {
        const re_abp_subscription_extractor =
            /\n\[Subscription\]\n+url=~[^\n]+([\x08-\x7E]*?)(?:\[Subscription\]|$)/ig;
        const re_abp_filter_extractor = /\[Subscription filters\]([\x08-\x7E]*?)(?:\[Subscription\]|$)/i;

        let matches = re_abp_subscription_extractor.exec(s);

        if (matches === null)
            return s;

        const out = [];

        do {
            if (matches.length === 2) {
                let filter_match = re_abp_filter_extractor.exec(matches[1].trim());
                if (filter_match !== null && filter_match.length === 2)
                    out.push(filter_match[1].trim().replace(/\\\[/g, "["));
            }
            matches = re_abp_subscription_extractor.exec(s);
        } while (matches !== null);

        return out.join("\n");
    };

    const on_file_reader_load = function () {
        let content = abp_importer(this.result);
        content = uBlockDashboard.mergeNewLines(nano.editor.get_unix_value().trim(), content);

        nano.editor.set_value_focus(content + "\n");
        nano.filters_changed();
    };

    const file = this.files[0];

    if (file === undefined || file.name === "")
        return;
    if (!file.type.startsWith("text"))
        return;

    const fr = new FileReader();
    fr.onload = on_file_reader_load;
    fr.readAsText(file);
};

nano.import_filters = () => {
    const input = document.getElementById("importFilePicker");
    input.value = "";
    input.click();
};

// ----------------------------------------------------------------------------------------------------------------- //

nano.export_filters = () => {
    const val = nano.editor.get_platform_value().trim();

    if (val === "")
        return;

    const filename = vAPI.i18n("1pExportFilename")
        .replace("{{datetime}}", uBlockDashboard.dateNowToSensibleString())
        .replace(/ +/g, "_");

    vAPI.download({
        "url": "data:text/plain;charset=utf-8," + encodeURIComponent(val + nano.editor.get_platform_line_break()),
        "filename": filename,
    });
};

// ----------------------------------------------------------------------------------------------------------------- //

nano.init = () => {
    let elem = document.getElementById("importUserFiltersFromFile");
    elem.addEventListener("click", nano.import_filters);

    elem = document.getElementById("importFilePicker");
    elem.addEventListener("change", nano.import_picked);

    elem = document.getElementById("exportUserFiltersToFile");
    elem.addEventListener("click", nano.export_filters);

    elem = document.getElementById("userFiltersApply");
    elem.addEventListener("click", nano.filters_apply);

    elem = document.getElementById("userFiltersRevert");
    elem.addEventListener("click", nano.filters_revert);

    nano.editor.on("change", nano.filters_changed);
    nano.load_settings();
};

// ----------------------------------------------------------------------------------------------------------------- //

cloud.onPush = () => {
    return nano.editor.get_unix_value();
};

cloud.onPull = (data, append) => {
    if (typeof data !== "string")
        return;

    if (append)
        data = uBlockDashboard.mergeNewLines(nano.editor.get_unix_value(), data);

    nano.editor.set_value_focus(data);
    nano.filters_changed();
};

// ----------------------------------------------------------------------------------------------------------------- //

nano.init();

nano.editor.on_key("save", "Ctrl-S", () => {
    const btn = document.getElementById("userFiltersApply");
    btn.click();
});

// ----------------------------------------------------------------------------------------------------------------- //
