// ==UserScript==
// @name		Dreadcast NPCs
// @author		Charlotte
// @version		1.0.0
// @grant       GM_xmlhttpRequest
// @grant       unsafeWindow
// @grant       GM_getValue
// @grant       GM_setValue
// @connect     raw.githubusercontent.com
// @description	Affiche des PNJ sur la carte de Dreadcast.
// @match		https://www.dreadcast.net/Main
// @copyright	2021+, None
// @namespace InGame
// ==/UserScript==

(function() {
    'use strict';

    // The script runs in Tampermonkey's sandbox: use the page's jQuery.
    const $ = unsafeWindow.jQuery;

    const NPC_SOURCE_URL = "https://raw.githubusercontent.com/charlotte-dc/dc-npc-generator/refs/heads/main/npcs.json";

    // Re-checked every NPC_CACHE_TTL_MS with its ETag (unchanged file = 304, no content).
    const NPC_CACHE_TTL_MS = 5 * 60 * 1000;

    const CACHE_STORAGE_KEY = 'npcFileCache_v1';
    const RETRY_MIN_MS = 30 * 1000;
    const RETRY_MAX_MS = 90 * 1000;

    function loadSavedCache() {
        try {
            const saved = GM_getValue(CACHE_STORAGE_KEY, null);
            if (saved && Array.isArray(saved.npcs) && Number.isFinite(saved.loadedAt)) {
                return { npcs: saved.npcs, loadedAt: saved.loadedAt, etag: saved.etag || null };
            }
        } catch (err) {
            console.error('[NPC] could not read the saved cache, starting empty:', err);
        }
        return null;
    }

    function saveCache() {
        try {
            GM_setValue(CACHE_STORAGE_KEY, npcFile);
        } catch (err) {
            console.error('[NPC] could not save the cache:', err);
        }
    }

    let npcFile = loadSavedCache();   // { npcs, loadedAt, etag } or null
    let pendingLoad = null;
    let nextRetryAt = 0;

    // Clean up the old per-building cache (v0.25 and earlier).
    try { GM_setValue('npcBuildingCache_v1', null); } catch (err) { /* ignore */ }

    $('body').append(`
  <style>
    #zone_info_pnjs {
    z-index: 3003;
    display: none;
    position: absolute;
    left: 0;
    bottom: 0;
    color: #fff;
    font-size: 10px;
    padding: 2px 4px;
    background: url(../../../images/fr/design/box6_fond_0.png)
    }
    #pnjs, #pnjs * {
    pointer-events: none;
    }
    #pnjs .npc_merged {
    visibility: hidden;
    }
  </style>
    `);

    // ====== Card defaults =========
    const NPC_DEFAULTS = {
        avatar: "https://cdn.britannica.com/80/157580-004-FFB75F13.jpg",
        durabilite: "",
        type: "",
        couleur: "#e0b84a",
    };

    // ====== NPC map icon =======
    // {couleur} is replaced by the NPC's colour.
    const NPC_ICON_SVG = `
<svg xmlns="http://www.w3.org/2000/svg" width="13" height="13" viewBox="0 0 13 13">
  <path fill="{couleur}" fill-rule="evenodd" d="M 5.46 1.40 A 1.20 1.20 0 0 1 7.54 1.40 L 12.74 10.40 A 1.20 1.20 0 0 1 11.70 12.20 L 1.30 12.20 A 1.20 1.20 0 0 1 0.26 10.40 Z M 5.98 2.70 A 0.60 0.60 0 0 1 7.02 2.70 L 11.35 10.20 A 0.60 0.60 0 0 1 10.83 11.10 L 2.17 11.10 A 0.60 0.60 0 0 1 1.65 10.20 Z"/>
  <path fill="{couleur}" d="M 5.98 4.20 A 0.60 0.60 0 0 1 7.02 4.20 L 10.05 9.45 A 0.60 0.60 0 0 1 9.53 10.35 L 3.47 10.35 A 0.60 0.60 0 0 1 2.95 9.45 Z"/>
</svg>`;

    function safeColor(value) {
        const v = String(value == null ? '' : value).trim();
        if (/^#([0-9a-f]{3}|[0-9a-f]{4}|[0-9a-f]{6}|[0-9a-f]{8})$/i.test(v)) return v;
        if (/^[a-z]{3,20}$/i.test(v)) return v;
        return NPC_DEFAULTS.couleur;
    }

    // In map units (a tile is 25).
    const NPC_ICON_SIZE = 17.5; // 70% of the tile

    function npcIconSvg(color) {
        return NPC_ICON_SVG.trim().split('{couleur}').join(color);
    }

    function soloIconCss() {
        const size = Math.max(1, Math.min(25, Number(NPC_ICON_SIZE) || 13));
        const offset = (25 - size) / 2;
        return {
            width: `${size}px`,
            height: `${size}px`,
            top: `${offset}px`,
            left: `${offset}px`,
            'background-size': `${size}px ${size}px`,
        };
    }

    function npcIconCss(npc) {
        const uri = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(npcIconSvg(safeColor(npc && npc.couleur)));
        return {
            'background-image': `url("${uri}")`,
            'background-position': '0 0',
            'background-size': '13px 13px',
            'background-repeat': 'no-repeat',
        };
    }


    // ====== Helpers =====
    function getGameMap() {
        try {
            return unsafeWindow.engine.getMap();
        } catch (err) {
            return null;
        }
    }

    function getCssCoordinate(x, y) {
        const map = getGameMap();
        if (!map) return [NaN, NaN];
        const size = Number(map.getTailleCase()) || 25;
        return [
            (Number(x) - Number(map.getOffsetX())) * size,
            (Number(y) - Number(map.getOffsetY())) * size,
        ];
    }

    function getIdFromUrl(url) {
        return url.replace(/(.*)[\_|\/](\d{1,5})\.(.*)/gi, '$2');
    }

    function getUrl(element) {
        return String($(element).css('background-image') || '')
            .replace('url(', '').replace(')', '').replace(/"/g, '');
    }

    function getCurrentBuildingId() {
        return Number(getIdFromUrl(getUrl('#carte_fond')));
    }

    function escapeHtml(text) {
        return String(text == null ? '' : text)
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&#39;');
    }

    function safeAvatar(url) {
        return /^https?:\/\//i.test(String(url || '').trim())
            ? String(url).trim()
            : NPC_DEFAULTS.avatar;
    }

    function ensurePnjsLayer() {
        if (!document.getElementById('pnjs')) {
            $('#carte_cases').append(`<div id="pnjs" style="z-index:9999;"></div>`);
        }
        if (!document.getElementById('zone_info_pnjs')) {
            $('#building_view').append(`<div id="zone_info_pnjs"/>`);
        }
    }

    function npcAtCursor() {
        const cadre = document.getElementById('cadre_position');
        const pnjs = document.getElementById('pnjs');
        if (!cadre || !pnjs || cadre.style.display === 'none') return null;
        const left = parseInt(cadre.style.left);
        const top = parseInt(cadre.style.top);
        const npcs = npcsOnTile(left, top);
        return npcs.length ? { npc: npcs[0], npcs, left, top } : null;
    }

    function npcsOnTile(left, top) {
        const pnjs = document.getElementById('pnjs');
        if (!pnjs) return [];
        return Array.from(pnjs.children)
            .filter(el => parseInt(el.style.left) === left && parseInt(el.style.top) === top)
            .map(el => $(el).data('npc'))
            .filter(Boolean);
    }

    // ====== NPC Card =====
    const makeCard = npc => `<div id="ib_persoBox_pnj0001"
    class="infoBoxFixed positionCenter obj_itemBox_details ui-draggable ui-draggable-handle onTop"
    style="z-index: 201; display: block; left: 35%; top: 15%;">
    <div class="conteneur_content_inlight"></div>
    <div class="infoBox_content">
        <div id="char_inspect_interieur" class="interieur" style="height:320px;padding:0px;">
            <div class="flipmobile-card">
                <div class="flipmobile-card-inner">
                    <div class="flipmobile-card-front">
                        <div class="close link" onclick="$('#ib_persoBox_pnj0001').remove();"></div>

                        <div class="flipmobile" onclick="flipMobile(this)">
                            <svg viewBox="0 0 283.5 283.5" class="">
                                <use xlink:href="#icon-tourauto" filter="url(#dropshadow)"></use>
                            </svg>
                        </div>

                        <div class="conteneur_avatar"><img
                                style="width:70px;height:70px;margin-right:20px;margin-top:1px;"
                                src="${escapeHtml(safeAvatar(npc.avatar))}"></div>
                        <div class="sexe_1" style="right: 15px;top: 9px;left: auto;"></div>
                        <div class="titreinfo couleur0">${escapeHtml(npc.name)}</div>
                        <div class="durabiliteinfo">${escapeHtml(npc.durabilite ?? NPC_DEFAULTS.durabilite)}</div>
                        <div class="typeinfo" style="line-height:14px;margin-top:8px;">${escapeHtml(npc.type ?? NPC_DEFAULTS.type)}</div>
                        <div class="description">${escapeHtml(npc.description)}</div>
                    </div>
                </div>
            </div>
        </div>
    </div>
</div>`;

    function openNpcCard(npc) {
        $('#ib_persoBox_pnj0001').remove();
        $('#zone_infoBoxFixed').append(makeCard(npc));
        $('#ib_persoBox_pnj0001').draggable();
    }

    // ====== Position window =====
    const POSITION_BOX_ID = 'npc_position_box';

    // Pre-filled form link: {batiment}, {x} and {y} are replaced by the current position.
    const NPC_FORM_URL = "https://docs.google.com/forms/d/e/1FAIpQLSddVAG_0ITsCqFNrdYv91zj91EZPDT-gW0b4864cuSgfSpkRA/viewform?usp=pp_url&entry.1574147046={batiment}&entry.966893939={x}&entry.1891610670={y}";

    function getPlayerPosition() {
        const map = getGameMap();
        if (!map) return null;
        return {
            x: Number(map.getOffsetX()) + Number(map.getPosX()),
            y: Number(map.getOffsetY()) + Number(map.getPosY()),
        };
    }

    function openPositionBox() {
        $('#' + POSITION_BOX_ID).remove();
        const $box = $(`<div id="${POSITION_BOX_ID}"
            class="infoBoxFixed positionCenter obj_itemBox_details ui-draggable ui-draggable-handle onTop"
            style="z-index: 201; display: block; left: 40%; top: 25%; width: 230px;">
            <div class="conteneur_content_inlight"></div>
            <div class="infoBox_content">
                <div class="interieur" style="padding:10px;">
                    <div class="close link"></div>
                    <div class="titreinfo couleur0">Créer un PNJ</div>
                    <div class="npc_pos_lines" style="margin-top:8px;line-height:16px;color:#fff;"></div>
                    <div class="btnTxt npc_pos_form" style="margin-top:8px;display:inline-block;">Créer un PNJ ici</div>
                </div>
            </div>
        </div>`);
        $box.find('.close').on('click', () => $box.remove());
        $box.find('.npc_pos_form').on('click', () => openNpcForm($box));
        $('#zone_infoBoxFixed').append($box);
        $box.draggable();
        renderPositionBox();
    }

    function renderPositionBox() {
        const $box = $('#' + POSITION_BOX_ID);
        if (!$box.length) return;
        const pos = getPlayerPosition();
        const buildingId = getCurrentBuildingId();
        const place = $('#lieu_actuel .titre1').first().text().trim();
        const address = $('#lieu_actuel .titre2').first().text().trim();
        const rows = [
            ['Lieu', place || '—'],
            ['Adresse', address || '—'],
            ['Bâtiment', Number.isFinite(buildingId) && buildingId > 0 ? String(buildingId) : '—'],
            ['Coordonnées', pos ? `x ${pos.x} / y ${pos.y}` : '—'],
            ['PNJ dans le bâtiment', String(currentNpcs().length)],
        ];
        const $lines = $box.find('.npc_pos_lines').empty();
        rows.forEach(([label, value]) => {
            const $value = $('<span></span>').text(value);
            $value[0].style.setProperty('color', '#fff', 'important');
            $('<div></div>')
                .append($('<span class="couleur5"></span>').text(label + ' : '))
                .append($value)
                .appendTo($lines);
        });
        $box.data('position', pos && Number.isFinite(buildingId) && buildingId > 0
            ? { batiment: buildingId, x: pos.x, y: pos.y } : null);
    }

    function openNpcForm($box) {
        const position = $box.data('position');
        if (!NPC_FORM_URL || !/^https:\/\/docs\.google\.com\/forms\//.test(NPC_FORM_URL)) {
            notify("Lien du formulaire non configuré.");
            return;
        }
        if (!position) {
            notify("Position indisponible : entrez dans un bâtiment.");
            return;
        }
        const url = NPC_FORM_URL
            .split('{batiment}').join(encodeURIComponent(position.batiment))
            .split('{x}').join(encodeURIComponent(position.x))
            .split('{y}').join(encodeURIComponent(position.y));
        window.open(url, '_blank', 'noopener');
    }

    function drawNpc(npc) {
        if (getCurrentBuildingId() !== Number(npc.id_batiment)) return;

        const [x, y] = getCssCoordinate(npc.x, npc.y);
        if (!Number.isFinite(x) || !Number.isFinite(y)) return;
        if (x < 0 || y < 0 || x > 500 || y > 500) return;
        const $npc = $(`<div class="icon_perso quantite1" style="left:${x}px;top:${y}px;">
            <div class="le_icon_perso numero1"></div>
        </div>`);
        $npc.children('.le_icon_perso').css(npcIconCss(npc)).css(soloIconCss());
        $npc.data('npc', npc);
        $('#pnjs').append($npc);
    }

    // ====== NPC sprites inside player pawns =======
    // Game CSS: quantite2 = diagonal, 3 = triangle, 4 = square (4 sprites max).
    const MAX_PAWN_SPRITES = 4;

    function mergeIntoPawn($pawn, npc) {
        const count = $pawn.children('.le_icon_perso').length;
        if (count >= MAX_PAWN_SPRITES) return;
        const classes = ($pawn.attr('class') || '').split(/\s+/);
        const current = classes.find(c => /^quantite\d+$/.test(c)) || `quantite${count}`;
        if ($pawn.attr('data-npc-quantite') === undefined) $pawn.attr('data-npc-quantite', current);
        $pawn.removeClass(current).addClass(`quantite${count + 1}`);
        const $sprite = $('<div class="le_icon_perso npc_sprite"></div>')
            .addClass(`numero${count + 1}`)
            .css(npcIconCss(npc));
        const $info = $pawn.children('.info_a_afficher');
        if ($info.length) $sprite.insertBefore($info); else $sprite.appendTo($pawn);
    }

    function unmergePawn($pawn) {
        $pawn.children('.npc_sprite').remove();
        const original = $pawn.attr('data-npc-quantite');
        if (original === undefined) return;
        const added = ($pawn.attr('class') || '').split(/\s+/).filter(c => /^quantite\d+$/.test(c));
        $pawn.removeClass(added.join(' ')).addClass(original).removeAttr('data-npc-quantite');
    }

    function unmergeNpcSprites() {
        $('.personnages .icon_perso').each(function() { unmergePawn($(this)); });
    }

    function syncPawnMerges() {
        const groups = new Map();
        $('#pnjs').children().each(function() {
            const key = `${parseInt(this.style.left)}_${parseInt(this.style.top)}`;
            if (!groups.has(key)) groups.set(key, []);
            groups.get(key).push(this);
        });

        $('.personnages .icon_perso[data-npc-quantite]').each(function() {
            const key = `${parseInt(this.style.left)}_${parseInt(this.style.top)}`;
            if (!groups.has(key)) unmergePawn($(this));
        });

        groups.forEach((els, key) => {
            const [left, top] = key.split('_').map(Number);
            const $els = $(els);
            const $pawn = playerPawnAt(left, top);
            if (!$pawn) {
                $els.removeClass('npc_merged');
                return;
            }
            $els.addClass('npc_merged');
            const playerSprites = $pawn.children('.le_icon_perso').not('.npc_sprite').length;
            const expected = Math.max(0, Math.min(els.length, MAX_PAWN_SPRITES - playerSprites));
            if ($pawn.children('.npc_sprite').length === expected) return;
            unmergePawn($pawn);
            for (let i = 0; i < expected; i++) mergeIntoPawn($pawn, $(els[i]).data('npc'));
        });
    }

    let listVersion = 0;
    let drawnKey = null;

    function currentDrawKey() {
        const map = getGameMap();
        if (!map) return null;
        return [map.getOffsetX(), map.getOffsetY(), getCurrentBuildingId(), listVersion].join('|');
    }

    function currentNpcs() {
        const buildingId = getCurrentBuildingId();
        if (!npcFile || !Number.isFinite(buildingId)) return [];
        return npcFile.npcs.filter(npc => Number(npc.id_batiment) === buildingId);
    }

    function refreshNpcs(force = false) {
        const buildingId = getCurrentBuildingId();
        if (!npcFile || Date.now() - npcFile.loadedAt > NPC_CACHE_TTL_MS) {
            loadNpcFile();
        }

        const layerWasMissing = !document.getElementById('pnjs');
        ensurePnjsLayer();
        const key = currentDrawKey();
        if (force || layerWasMissing || key !== drawnKey) {
            const npcs = currentNpcs();
            unmergeNpcSprites();
            $('#pnjs').empty();
            npcs.forEach(npc => drawNpc(npc));
            drawnKey = key;
        }
        syncPawnMerges();
        renderPositionBox();
    }

    // GM_xmlhttpRequest is not subject to the site's CSP.
    function gmGetJson(url, etag) {
        return new Promise((resolve, reject) => {
            GM_xmlhttpRequest({
                method: 'GET',
                url,
                timeout: 15000,
                headers: etag ? { 'If-None-Match': etag } : {},
                onload: res => {
                    if (res.status === 304) {
                        resolve({ notModified: true });
                        return;
                    }
                    if (res.status < 200 || res.status >= 300) {
                        reject(new Error('HTTP ' + res.status));
                        return;
                    }
                    const match = /^etag:\s*(.+)$/im.exec(res.responseHeaders || '');
                    try {
                        resolve({ json: JSON.parse(res.responseText), etag: match ? match[1].trim() : null });
                    } catch (err) {
                        reject(new Error('Response is not JSON: ' + res.responseText.slice(0, 200)));
                    }
                },
                onerror: () => reject(new Error('Network error')),
                ontimeout: () => reject(new Error('Timed out')),
            });
        });
    }

    function loadNpcFile(force = false) {
        if (pendingLoad) return pendingLoad;
        if (!force && npcFile && Date.now() - npcFile.loadedAt <= NPC_CACHE_TTL_MS) return Promise.resolve('cached');
        if (!force && Date.now() < nextRetryAt) return Promise.resolve('waiting');

        pendingLoad = gmGetJson(NPC_SOURCE_URL, npcFile && npcFile.etag)
            .then(result => {
                if (result.notModified) {
                    npcFile.loadedAt = Date.now();
                    saveCache();
                    return 'unchanged';
                }
                const json = result.json;
                const rows = Array.isArray(json) ? json : (Array.isArray(json && json.data) ? json.data : []);
                const npcs = rows.filter(npc => npc && String(npc.name || '').trim() !== '');
                npcFile = { npcs, loadedAt: Date.now(), etag: result.etag };
                saveCache();
                listVersion++;
                refreshNpcs(true);
                return 'updated';
            })
            .catch(err => {
                const delay = RETRY_MIN_MS + Math.random() * (RETRY_MAX_MS - RETRY_MIN_MS);
                nextRetryAt = Date.now() + delay;
                console.error(`[NPC] could not load npcs.json, keeping the current list; retry in ${Math.round(delay / 1000)} s:`, err);
                return 'failed';
            })
            .finally(() => {
                pendingLoad = null;
            });
        return pendingLoad;
    }

    // ====== GUI =====
    const RELOAD_MESSAGES = {
        updated: "PNJ mis à jour.",
        unchanged: "Les PNJ sont déjà à jour.",
        failed: "Impossible de charger les PNJ, réessayez plus tard.",
    };

    const $paramsMenu = $('.menus > .parametres > ul');
    $('<li />').appendTo($paramsMenu)
        .text("Recharger les PNJ")
        .addClass('link couleur2 separator')
        .click(() => {
            loadNpcFile(true).then(status => notify(RELOAD_MESSAGES[status] || RELOAD_MESSAGES.unchanged));
        });

    $('<li />').appendTo($paramsMenu)
        .text("Créer un PNJ")
        .addClass('link couleur2')
        .click(() => openPositionBox());

    ensurePnjsLayer();

    // ====== Hover =======
    const hoverObserver = new MutationObserver(() => {
        const hit = npcAtCursor();
        const $info = $("#zone_info_pnjs");
        if (hit && playerPawnAt(hit.left, hit.top)) {
            $info.css("display", "none");
            addNpcNamesToGameTooltip(hit);
        } else if (hit) {
            $info.text(hit.npc.name);
            $info.css({ display: "block", left: hit.left + 25, bottom: 525 - hit.top });
        } else {
            $info.css("display", "none");
        }
    });

    const hoverFrame = document.getElementById('cadre_position');
    if (hoverFrame) {
        hoverObserver.observe(hoverFrame, { attributes : true, attributeFilter : ['style'] });
    }

    const gameTooltip = document.getElementById('zone_carte_info');
    if (gameTooltip) {
        new MutationObserver(() => {
            const hit = npcAtCursor();
            if (hit && playerPawnAt(hit.left, hit.top)) addNpcNamesToGameTooltip(hit);
        }).observe(gameTooltip, { childList: true, characterData: true, subtree: true });
    }

    // ====== NPC action menu =======
    const TILE = 25;

    function notify(text) {
        try {
            unsafeWindow.engine.displayLightInfo(text, 4);
        } catch (err) {
            console.log('[NPC]', text);
        }
    }

    function getMeubleAt(left, top) {
        const map = getGameMap();
        if (!map || typeof map.presenceMeuble !== 'function') return null;
        return map.presenceMeuble(Math.round(left / TILE), Math.round(top / TILE)) || null;
    }

    function closeNpcMenu() {
        $('#menu_actions').trigger('close');
    }

    $('#menu_actions').on('close', () => $('#menu_actions .npc_action').remove());

    function moveToNpc(left, top) {
        const map = getGameMap();
        if (!map || typeof map.deplacement !== 'function') {
            notify("Déplacement impossible pour le moment.");
            return;
        }
        map.deplacement(null, left + TILE / 2, top + TILE / 2);
    }

    function useFurniture(left, top) {
        const map = getGameMap();
        const meuble = getMeubleAt(left, top);
        if (!map || !meuble) {
            notify("Aucun meuble à cet endroit.");
            return;
        }
        unsafeWindow.engine.updateBuildingInfos('meuble', meuble.attr('id'), map.getId() + ' #croix_position');
    }

    function openNpcMenu(hit) {
        const { npc, left, top } = hit;
        const meuble = getMeubleAt(left, top);

        const actions = [
            { icon: 'icon-deplacement', title: "S'y rendre", run: () => moveToNpc(left, top) },
        ];
        if (meuble) {
            actions.push({ icon: 'icon-fouiller', title: 'Examiner le meuble', run: () => useFurniture(left, top) });
        }
        actions.push({ icon: 'icon-fiche', title: 'Fiche', run: () => openNpcCard(npc) });

        const $menu = $('#menu_actions');
        $menu.children('.action_perso').remove();
        $('#action1, #action2, #action3, #action4').hide();
        $('#liste_cibler').hide();

        actions.forEach((action, i) => {
            const $btn = $(`<div class="infoAide action_perso link page_0 action_${i} npc_action" alt="2">
                <div class="inset_action_perso">
                    <svg viewBox="0 0 283.46 283.46"><use xlink:href="#${action.icon}" filter="url(#dropshadow)"></use></svg>
                </div>
            </div>`);
            $btn.attr('title', action.title);
            $btn.on('click', e => {
                e.stopPropagation();
                closeNpcMenu();
                action.run();
            });
            $menu.append($btn);
        });

        $menu.attr('class', `hide page_0 configuration_${actions.length - 1}`)
             .css({ left: left - 16, top: top - 16 })
             .addClass('show')
             .removeClass('hide');
        $('#zone_info_pnjs').hide();
    }

    // ====== NPC stacked with real players =======
    function playerPawnAt(left, top) {
        const map = getGameMap();
        if (!map || typeof map.presencePersonnage !== 'function') return null;
        return map.presencePersonnage(Math.round(left / TILE), Math.round(top / TILE)) || null;
    }

    function addNpcNamesToGameTooltip(hit) {
        const $tip = $('#zone_carte_info');
        if (!$tip.length || $tip.find('.npc_names').length) return;
        const $names = $('<span class="npc_names"></span>');
        hit.npcs.forEach(npc => $names.append('<br>').append(document.createTextNode(npc.name)));
        $tip.append($names);
    }

    function playersOfPawn($pawn) {
        const names = ($pawn.find('.info_a_afficher').html() || '').split(/<br\s*\/?>/i);
        const ids = String($pawn.attr('ids') || '').split('_');
        const vies = String($pawn.attr('vie') || '').split('_');
        return ids.map((id, i) => ({ id: parseInt(id, 10), name: $('<div>').html(names[i] || '').text(), vie: vies[i] }));
    }

    function npcTargetItem(npc, left, top) {
        return $('<li class="link"></li>').text(npc.name).on('click', () => {
            $('#liste_cibler').hide();
            openNpcMenu({ npc, npcs: [npc], left, top });
        });
    }

    function addNpcsToPlayerMenu(hit) {
        const map = getGameMap();
        const $pawn = playerPawnAt(hit.left, hit.top);
        if (!map || !$pawn) return;

        const tileX = Math.round(hit.left / TILE);
        const tileY = Math.round(hit.top / TILE);
        const players = playersOfPawn($pawn);
        const total = players.length + hit.npcs.length;
        const $menu = $('#menu_actions');

        if (players.length > 1) {
            const $lister = $('#action_perso_lister');
            if (!$lister.length) return;
            $lister.html(`Cibler (${total})`);
            $lister.on('click', () => {
                const $content = $('#liste_cibler .content');
                hit.npcs.forEach(npc => $content.append(npcTargetItem(npc, hit.left, hit.top)));
            });
            return;
        }

        $menu.children('.action_perso').remove();
        $('#actionDefault').clone().appendTo($menu)
            .attr('id', 'action_perso_deplacement')
            .attr('class', 'infoAide action_perso link page_0 action_0')
            .attr('title', map.actions_personnage.deplacement[1])
            .click(map.actions_personnage.deplacement[2]);
        $('#actionDefault').clone().appendTo($menu)
            .attr('id', 'action_perso_lister')
            .attr('class', 'action_perso link page_0 action_7')
            .html(`Cibler (${total})`)
            .click(() => {
                const $content = $('#liste_cibler .content').html('');
                players.forEach(p => {
                    $('<li class="link"></li>').text(p.name).on('click', () => {
                        map.executeActionPersonnage(tileX, tileY, hit.left, hit.top, p.id, p.name, p.vie);
                    }).appendTo($content);
                });
                hit.npcs.forEach(npc => $content.append(npcTargetItem(npc, hit.left, hit.top)));
                $('#liste_cibler').show();
                $content.slideDown('fast');
            });
        $menu.css({ left: hit.left - 16, top: hit.top - 16 });
        $('#action1, #action2, #action3').hide();
        $menu.addClass('show').removeClass('hide');
    }

    // ====== Clicks on NPC tiles =======
    // Every click phase is blocked: the game also reacts to mouseup.
    ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click', 'dblclick'].forEach(type => {
        document.addEventListener(type, e => {
            const carte = document.getElementById('carte');
            if (!carte || !carte.contains(e.target)) return;
            const hit = npcAtCursor();
            if (!hit) return;
            if (playerPawnAt(hit.left, hit.top)) {
                if (type === 'click') setTimeout(() => addNpcsToPlayerMenu(hit), 0);
                return;
            }
            e.stopPropagation();
            e.preventDefault();
            if (type === 'click') openNpcMenu(hit);
        }, true);
    });

    // ====== Map rewrites =======
    // Synchronous re-sync (before paint) avoids flicker.
    function isOwnChange(record) {
        const pnjs = document.getElementById('pnjs');
        if (pnjs && (record.target === pnjs || pnjs.contains(record.target))) return true;
        const nodes = [...record.addedNodes, ...record.removedNodes];
        return nodes.length > 0 && nodes.every(n =>
            n.nodeType === 1 && (n.id === 'pnjs' || n.classList.contains('npc_sprite')));
    }

    const mapCases = document.getElementById('carte_cases');
    if (mapCases) {
        new MutationObserver(records => {
            if (records.every(isOwnChange)) return;
            refreshNpcs();
        }).observe(mapCases, { childList: true, subtree: true });
    }

    // ====== Movement =======
    $(document).ready(() => {
        refreshNpcs(true);
    });

    $(document).ajaxComplete((event, xhr, settings) => {
        if (!/Action\/(Move|Enter)/.test(settings.url || '')) return;
        setTimeout(() => refreshNpcs(), 0);
        // The building image changes ~1 s later on a building change.
        setTimeout(() => refreshNpcs(), 1500);
    });
})();