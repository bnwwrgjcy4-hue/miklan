const express = require('express');
const imaps = require('imap-simple');
const { simpleParser } = require('mailparser');
const cheerio = require('cheerio');

const app = express();
const PORT = 3000;

const config = {
    imap: {
        user: 'sk012w@miklan.pl',
        password: 'miklansk012w',
        host: 'poczta.miklan.pl',
        port: 993,
        tls: true,
        authTimeout: 15000,
        tlsOptions: { rejectUnauthorized: false }
    }
};

let cache = {
    locationsList: [],
    lastFetched: 0
};
let isFetching = false;

function parseEmailDetails(subject, textBody, htmlBody) {
    if (!subject) subject = '';
    
    const match = subject.match(/(?:PDF\s+)?([^,]+),\s*([A-Za-ząęśćżźółńĄĘŚĆŻŹÓŁŃ\s-]+)\s+\d{2}-\d{3}/i);
    let street = 'Inne miejsce';
    let city = 'Inne';

    if (match && match[1] && match[2]) {
        street = match[1].replace(/PDF/i, '').trim();
        city = match[2].trim();
    }

    let wasteType = 'Zlecenie odbioru';
    let shortType = 'Zlecenie';
    
    const fullTextToSearch = `${subject} ${textBody || ''} ${htmlBody || ''}`.toLowerCase();

    const is05 = fullTextToSearch.includes('15 01 05') || 
                 fullTextToSearch.includes('15.01.05') || 
                 fullTextToSearch.includes('15-01-05') || 
                 fullTextToSearch.includes('wielomateriał') || 
                 fullTextToSearch.includes('/05/') || 
                 fullTextToSearch.includes('kod: 05') ||
                 fullTextToSearch.includes('rodzaj: 05');

    const is01 = fullTextToSearch.includes('15 01 01') || 
                 fullTextToSearch.includes('15.01.01') || 
                 fullTextToSearch.includes('15-01-01') || 
                 fullTextToSearch.includes('makulatur') || 
                 fullTextToSearch.includes('belki makulatura') || 
                 fullTextToSearch.includes('/01/') || 
                 fullTextToSearch.includes('kod: 01') ||
                 fullTextToSearch.includes('rodzaj: 01');

    if (is05 && !is01) {
        wasteType = '15 01 05 - BELKI WIELOMATERIAŁOWE';
        shortType = '05';
    } else if (is01 && !is05) {
        wasteType = '15 01 01 - BELKI MAKULATURA';
        shortType = '01';
    } else if (is05 && is01) {
        wasteType = '15 01 01 / 15 01 05';
        shortType = '01 & 05';
    } else {
        if (fullTextToSearch.includes('mak') || fullTextToSearch.includes('papel') || fullTextToSearch.includes('karton')) {
            wasteType = '15 01 01 - BELKI MAKULATURA';
            shortType = '01';
        } else if (fullTextToSearch.includes('wielo') || fullTextToSearch.includes('tetra')) {
            wasteType = '15 01 05 - BELKI WIELOMATERIAŁOWE';
            shortType = '05';
        }
    }

    return {
        street,
        city,
        fullLocation: `${street}, ${city}`,
        wasteType,
        shortType
    };
}

async function backgroundFetch() {
    if (isFetching) return;
    isFetching = true;

    let connection;
    try {
        console.log('Pobieranie wiadomości z poczty...');
        connection = await imaps.connect(config);
        await connection.openBox('INBOX', true);

        const searchCriteria = ['ALL'];
        const fetchOptions = { bodies: [''], markSeen: false };

        const messages = await connection.search(searchCriteria, fetchOptions);
        if (connection) { try { await connection.end(); } catch (e) {} }

        let requests = [];
        let confirmations = new Set();
        const reversedMessages = messages.reverse();

        for (const item of reversedMessages) {
            const allPart = item.parts.find(p => p.which === '');
            if (!allPart) continue;

            try {
                const parsed = await simpleParser(allPart.body);
                const subject = parsed.subject || '';
                const lowerSubject = subject.toLowerCase();

                const isConfirmation = lowerSubject.includes('potwierdzen') || 
                                       lowerSubject.includes('potwierdzenie') || 
                                       lowerSubject.includes('zrealizowan') || 
                                       lowerSubject.includes('odebrano');

                const details = parseEmailDetails(subject, parsed.text, parsed.html);

                if (isConfirmation) {
                    confirmations.add(details.fullLocation);
                } else {
                    requests.push({ item, parsed, details });
                }
            } catch (err) {
                continue;
            }
        }

        let validMessages = [];
        for (const req of requests) {
            if (validMessages.length >= 150) break;
            if (confirmations.has(req.details.fullLocation)) continue;
            validMessages.push(req);
        }

        let locationsMap = new Map();

        for (const { item, parsed, details } of validMessages) {
            let mainLink = '';
            const htmlContent = parsed.html || parsed.textAsHtml;
            
            if (htmlContent) {
                try {
                    const $ = cheerio.load(htmlContent);
                    let foundLinks = [];
                    
                    $('a').each((i, link) => {
                        const href = $(link).attr('href');
                        if (href && href.startsWith('http')) {
                            foundLinks.push(href);
                        }
                    });

                    if (foundLinks.length === 0) {
                        $('[onclick], [data-href], [data-url]').each((i, el) => {
                            let attrVal = $(el).attr('onclick');
                            if (!attrVal) attrVal = $(el).attr('data-href');
                            if (!attrVal) attrVal = $(el).attr('data-url');

                            if (attrVal) {
                                const urlMatch = attrVal.match(/https?:\/\/[^\s'"]+/);
                                if (urlMatch) {
                                    foundLinks.push(urlMatch[0]);
                                }
                            }
                        });
                    }

                    let cleanLinks = [];
                    for (const href of foundLinks) {
                        const low = href.toLowerCase();
                        const isBad = low.includes('unsubscribe') || 
                                      low.includes('facebook.com') || 
                                      low.includes('instagram.com') || 
                                      low.includes('privacy-policy');
                        if (!isBad) {
                            cleanLinks.push(href);
                        }
                    }

                    if (cleanLinks.length > 0) {
                        mainLink = cleanLinks[0];
                    } else if (foundLinks.length > 0) {
                        mainLink = foundLinks[0];
                    }
                } catch (e) {}
            }

            if (!mainLink && parsed.text) {
                const urlMatches = parsed.text.match(/https?:\/\/[^\s<>\"]+/g);
                if (urlMatches && urlMatches.length > 0) {
                    let validTextUrl = '';
                    for (const u of urlMatches) {
                        if (!u.toLowerCase().includes('unsubscribe')) {
                            validTextUrl = u;
                            break;
                        }
                    }
                    mainLink = validTextUrl || urlMatches[0];
                }
            }

            if (!mainLink || mainLink === '#') {
                continue; 
            }

            const subject = parsed.subject || 'Brak tematu';
            const isUnread = item.attributes.flags && !item.attributes.flags.includes('\\Seen');

            if (!locationsMap.has(details.fullLocation)) {
                locationsMap.set(details.fullLocation, {
                    city: details.city,
                    street: details.street,
                    emails: []
                });
            }

            locationsMap.get(details.fullLocation).emails.push({
                subject,
                date: parsed.date ? parsed.date.toLocaleDateString('pl-PL') + ' ' + parsed.date.toLocaleTimeString([], {hour: '2-digit', minute:'2-digit'}) : 'Brak daty',
                rawDate: parsed.date ? new Date(parsed.date).getTime() : 0,
                mainLink,
                isUnread,
                wasteType: details.wasteType,
                shortType: details.shortType
            });
        }

        let locationsList = [];
        for (let [fullLocation, data] of locationsMap.entries()) {
            data.emails.sort((a, b) => b.rawDate - a.rawDate);
            
            let selectedEmails = [];
            let found01 = false;
            let found05 = false;

            for (const mail of data.emails) {
                if (mail.shortType.includes('01') && !found01) {
                    selectedEmails.push(mail);
                    found01 = true;
                } else if (mail.shortType.includes('05') && !found05) {
                    selectedEmails.push(mail);
                    found05 = true;
                } else if (!mail.shortType.includes('01') && !mail.shortType.includes('05') && selectedEmails.length < 2) {
                    selectedEmails.push(mail);
                }
                
                if (found01 && found05) break;
            }

            if (selectedEmails.length === 0 && data.emails.length > 0) {
                selectedEmails.push(data.emails[0]);
            }

            let unreadCount = 0;
            for (const e of selectedEmails) {
                if (e.isUnread) unreadCount++;
            }

            let typesArr = [];
            for (const e of selectedEmails) {
                if (!typesArr.includes(e.shortType)) typesArr.push(e.shortType);
            }
            let typesSet = typesArr.join(', ');

            locationsList.push({
                fullLocation,
                city: data.city,
                street: data.street,
                count: selectedEmails.length,
                unreadCount,
                typesSummary: typesSet,
                emails: selectedEmails
            });
        }

        cache.locationsList = locationsList;
        cache.lastFetched = Date.now();
        console.log(`Pobrano dane pomyślnie. Aktywnych lokalizacji: ${locationsList.length}`);
    } catch (error) {
        console.error('Błąd podczas pobierania:', error.message);
        if (connection) { try { await connection.end(); } catch (e) {} }
    } finally {
        isFetching = false;
    }
}

app.get('/', async (req, res) => {
    if (cache.locationsList.length === 0) {
        await backgroundFetch();
    }

    const locationsList = cache.locationsList;
    const selectedLocQuery = req.query.loc;
    let selectedLocationData = null;
    if (selectedLocQuery) {
        for (const l of locationsList) {
            if (l.fullLocation === selectedLocQuery) {
                selectedLocationData = l;
                break;
            }
        }
    }

    let htmlResponse = `
        <!DOCTYPE html>
        <html lang="pl">
        <head>
            <meta charset="UTF-8">
            <meta name="viewport" content="width=device-width, initial-scale=1.0">
            <title>Miklan - Panel Zleceń</title>
            <meta http-equiv="refresh" content="15">
            <style>
                :root {
                    --bg: #090d16;
                    --surface: #111827;
                    --surface-hover: #1f2937;
                    --border: #374151;
                    --text-main: #f9fafb;
                    --text-muted: #9ca3af;
                    --primary: #6366f1;
                    --primary-glow: rgba(99, 102, 241, 0.2);
                    --radius: 14px;
                }
                * { box-sizing: border-box; }
                body {
                    font-family: system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
                    background-color: var(--bg);
                    color: var(--text-main);
                    margin: 0;
                    padding: 24px;
                    -webkit-tap-highlight-color: transparent;
                }
                .container { max-width: 1350px; margin: 0 auto; }
                
                /* Przyklejony nagłówek (Sticky Header) */
                .sticky-header {
                    position: sticky;
                    top: 0;
                    z-index: 100;
                    background: rgba(17, 24, 39, 0.85);
                    backdrop-filter: blur(10px);
                    border: 1px solid var(--border);
                    border-radius: var(--radius);
                    padding: 20px;
                    margin-bottom: 24px;
                    box-shadow: 0 10px 25px -5px rgba(0, 0, 0, 0.4);
                }
                .header-row { display: flex; justify-content: space-between; align-items: center; margin-bottom: 14px; }
                h1 { font-size: 1.4rem; font-weight: 800; margin: 0; letter-spacing: -0.03em; background: linear-gradient(to right, #ffffff, #9ca3af); -webkit-background-clip: text; -webkit-text-fill-color: transparent; }
                
                .stats-badges { display: flex; gap: 8px; align-items: center; }
                .stat-pill {
                    font-size: 0.75rem;
                    background: rgba(255,255,255,0.05);
                    border: 1px solid var(--border);
                    padding: 6px 12px;
                    border-radius: 20px;
                    font-weight: 600;
                    color: var(--text-muted);
                }
                .stat-pill span { color: var(--text-main); font-weight: 700; }

                .live-badge { 
                    font-size: 0.75rem; 
                    color: #34d399; 
                    background: rgba(16, 185, 129, 0.1); 
                    border: 1px solid rgba(16, 185, 129, 0.2);
                    padding: 6px 12px; 
                    border-radius: 20px; 
                    font-weight: 600; 
                    display: inline-flex; 
                    align-items: center; 
                    gap: 6px;
                }
                .live-badge::before {
                    content: "";
                    width: 6px;
                    height: 6px;
                    background-color: #34d399;
                    border-radius: 50%;
                    box-shadow: 0 0 8px #34d399;
                    display: inline-block;
                }

                .back-link { 
                    font-size: 0.85rem; 
                    color: var(--primary); 
                    text-decoration: none; 
                    font-weight: 600; 
                    display: inline-flex;
                    align-items: center;
                    gap: 6px;
                    margin-bottom: 16px;
                    transition: transform 0.2s;
                }
                .back-link:hover { transform: translateX(-3px); }
                
                .search-box { position: relative; width: 100%; }
                .search-box input { 
                    width: 100%; 
                    padding: 12px 16px 12px 44px; 
                    border: 1px solid var(--border); 
                    border-radius: 10px; 
                    background: #030712; 
                    color: var(--text-main);
                    font-size: 0.95rem; 
                    outline: none; 
                    transition: all 0.2s;
                }
                .search-box input:focus { 
                    border-color: var(--primary); 
                    box-shadow: 0 0 0 4px var(--primary-glow); 
                }
                .search-icon {
                    position: absolute;
                    left: 16px;
                    top: 50%;
                    transform: translateY(-50%);
                    color: var(--text-muted);
                    font-size: 1rem;
                }
                
                /* Układ siatki: 3 kafelki obok siebie na szerokich ekranach */
                .grid-container {
                    display: grid;
                    grid-template-columns: repeat(auto-fill, minmax(360px, 1fr));
                    gap: 16px;
                }

                /* Kafelki */
                .card {
                    background: var(--surface);
                    border: 1px solid var(--border);
                    border-radius: var(--radius);
                    padding: 18px;
                    box-shadow: 0 4px 6px -1px rgba(0, 0, 0, 0.2);
                    cursor: pointer;
                    display: flex;
                    flex-direction: column;
                    justify-content: space-between;
                    text-decoration: none;
                    color: inherit;
                    transition: all 0.25s cubic-bezier(0.4, 0, 0.2, 1);
                }
                .card:hover { 
                    border-color: var(--primary); 
                    background: var(--surface-hover);
                    transform: translateY(-3px);
                    box-shadow: 0 12px 20px -8px var(--primary-glow);
                }
                
                .card-header { display: flex; justify-content: space-between; align-items: flex-start; gap: 10px; margin-bottom: 8px; }
                .title { font-size: 1.05rem; font-weight: 700; color: var(--text-main); letter-spacing: -0.01em; }
                
                .tags-row { display: flex; gap: 6px; align-items: center; flex-wrap: wrap; }
                .badge { background: rgba(99, 102, 241, 0.1); color: #818cf8; border: 1px solid rgba(99, 102, 241, 0.2); font-size: 0.7rem; font-weight: 600; padding: 3px 8px; border-radius: 6px; }
                .badge-unread { background: rgba(239, 68, 68, 0.1); color: #f87171; border: 1px solid rgba(239, 68, 68, 0.2); }
                
                .card-info { margin: 8px 0; font-size: 0.85rem; color: var(--text-muted); display: flex; align-items: center; justify-content: space-between; }
                .type-highlight { font-weight: 600; color: var(--text-main); background: rgba(255,255,255,0.05); padding: 3px 8px; border-radius: 6px; border: 1px solid var(--border); }
                
                .card-footer { font-size: 0.8rem; color: var(--text-muted); display: flex; justify-content: space-between; align-items: center; margin-top: 12px; padding-top: 10px; border-top: 1px solid rgba(255,255,255,0.05); }
                .action-text { color: #818cf8; font-weight: 600; }

                .empty-state { text-align: center; color: var(--text-muted); padding: 50px 0; font-size: 1rem; background: var(--surface); border: 1px dashed var(--border); border-radius: var(--radius); grid-column: 1 / -1; }
            </style>
        </head>
        <body>
            <div class="container">
    `;

    if (selectedLocationData) {
        htmlResponse += `
            <a href="/" class="back-link">← Powrót do listy lokalizacji</a>
            <div class="sticky-header" style="margin-bottom: 16px;">
                <h1>📍 ${selectedLocationData.fullLocation}</h1>
                <p style="font-size: 0.85rem; color: var(--text-muted); margin: 6px 0 0 0;">Wybierz konkretne zlecenie, aby otworzyć dokument:</p>
            </div>
            <div class="grid-container">
        `;

        selectedLocationData.emails.forEach(mail => {
            htmlResponse += `
                <a class="card" href="${mail.mainLink}" target="_blank">
                    <div>
                        <div class="card-header">
                            <span class="title" style="color: #818cf8;">📦 ${mail.wasteType}</span>
                            <div class="tags-row">
                                ${mail.isUnread ? '<span class="badge badge-unread">Nowy</span>' : '<span class="badge">Przeczytany</span>'}
                            </div>
                        </div>
                        <div style="font-size: 0.85rem; color: var(--text-muted); line-height: 1.4; margin-bottom: 4px;">${mail.subject}</div>
                    </div>
                    <div class="card-footer">
                        <span>📅 ${mail.date}</span>
                        <span style="color: #34d399; font-weight: 600;">Otwórz link →</span>
                    </div>
                </a>
            `;
        });

        htmlResponse += `</div>`;

    } else {
        htmlResponse += `
            <div class="sticky-header">
                <div class="header-row">
                    <h1>📥 Zlecenia Miklan</h1>
                    <div class="stats-badges">
                        <span class="stat-pill">Aktywne: <span>${locationsList.length}</span></span>
                        <span class="live-badge">Live</span>
                    </div>
                </div>
                <div class="search-box">
                    <span class="search-icon">🔍</span>
                    <input type="text" id="searchInput" placeholder="Szukaj po ulicy lub mieście..." onkeyup="filterLocations()">
                </div>
            </div>
            <div class="grid-container" id="cardsContainer">
        `;

        if (locationsList.length === 0) {
            htmlResponse += `<div class="empty-state">Brak aktywnych zleceń do wyświetlenia.</div>`;
        } else {
            locationsList.forEach(loc => {
                htmlResponse += `
                    <a class="card location-card" href="/?loc=${encodeURIComponent(loc.fullLocation)}" data-search="${loc.fullLocation.toLowerCase()}">
                        <div>
                            <div class="card-header">
                                <span class="title">📍 ${loc.street}</span>
                                <div class="tags-row">
                                    ${loc.unreadCount > 0 ? `<span class="badge badge-unread">${loc.unreadCount} nowych</span>` : ''}
                                    <span class="badge">${loc.city}</span>
                                </div>
                            </div>
                            <div class="card-info">
                                <span style="color: var(--text-muted);">Rodzaj:</span> 
                                <span class="type-highlight">${loc.typesSummary}</span>
                            </div>
                        </div>
                        <div class="card-footer">
                            <span>Zlecenia: <strong>${loc.count}</strong></span>
                            <span class="action-text">Zarządzaj →</span>
                        </div>
                    </a>
                `;
            });
        }

        htmlResponse += `
            </div>
            <script>
                function filterLocations() {
                    const searchText = document.getElementById('searchInput').value.toLowerCase();
                    const cards = document.querySelectorAll('.location-card');

                    cards.forEach(card => {
                        const searchData = card.getAttribute('data-search');
                        if (searchData.includes(searchText)) {
                            card.style.display = 'flex';
                        } else {
                            card.style.display = 'none';
                        }
                    });
                }
            </script>
        `;
    }

    htmlResponse += `
        </div>
        </body>
        </html>
    `;

    res.send(htmlResponse);
});

async function startApp() {
    console.log('Pobieranie początkowe wiadomości z poczty przed startem serwera...');
    await backgroundFetch();

    app.listen(PORT, () => {
        console.log(`Serwer gotowy do działania! Otwórz: http://localhost:${PORT}`);
    });

    setInterval(backgroundFetch, 15000);
}

startApp();