const imaps = require('imap-simple');
const { simpleParser } = require('mailparser');
const cheerio = require('cheerio');

const config = {
    imap: {
        user: 'sk012w@miklan.pl',
        password: 'miklansk012w', // Wpisz tutaj swoje hasło
        host: 'poczta.miklan.pl',
        port: 993,
        tls: true,
        authTimeout: 10000,
        tlsOptions: { rejectUnauthorized: false }
    }
};

async function processEmails() {
    try {
        console.log('Łączenie z serwerem pocztowym home.pl...');
        const connection = await imaps.connect(config);
        console.log('Połączono pomyślnie!');

        await connection.openBox('INBOX');

        const searchCriteria = ['ALL'];
        const fetchOptions = {
            bodies: [''],
            markSeen: false
        };

        const messages = await connection.search(searchCriteria, fetchOptions);
        console.log(`Znaleziono wiadomości w skrzynce: ${messages.length}`);

        // Bierzemy 3 ostatnie wiadomości do analizy
        const recentMessages = messages.slice(-3);
        
        for (const item of recentMessages) {
            const allPart = item.parts.find(p => p.which === '');
            const parsed = await simpleParser(allPart.body);

            console.log('\n==================================================');
            console.log(`Temat: ${parsed.subject}`);
            console.log(`Od: ${parsed.from ? parsed.from.text : 'Nieznany'}`);
            
            // 1. Obsługa Załączników
            if (parsed.attachments && parsed.attachments.length > 0) {
                console.log('📎 Załączniki:');
                parsed.attachments.forEach((att, index) => {
                    console.log(`   [${index + 1}] Nazwa: ${att.filename}, Rozmiar: ${att.size} bajtów`);
                    // Tutaj w kolejnych krokach zapiszemy plik na dysk lub powiążemy z BDO/zlecenie
                });
            } else {
                console.log('📎 Załączniki: Brak');
            }

            // 2. Obsługa Linków z treści HTML
            console.log('🔗 Linki w treści (AKCJE / LINKI):');
            const htmlContent = parsed.html || parsed.textAsHtml;
            
            if (htmlContent) {
                const $ = cheerio.load(htmlContent);
                let linkCount = 0;

                $('a').each((i, link) => {
                    const href = $(link).attr('href');
                    const text = $(link).text().trim().replace(/\s+/g, ' '); // Oczyszczenie tekstu z białych znaków
                    
                    if (href && href.startsWith('http')) {
                        linkCount++;
                        console.log(`   [Link ${linkCount}]`);
                        console.log(`      Tekst/Nazwa: "${text || 'Brak etykiety'}"`);
                        console.log(`      Adres (href): ${href}`);
                    }
                });

                if (linkCount === 0) {
                    console.log('   Brak linków HTTP w treści.');
                }
            } else {
                console.log('   Brak treści HTML w wiadomości.');
            }
        }

        await connection.end();
        console.log('\n==================================================');
        console.log('Rozłączono poprawnie.');

    } catch (error) {
        console.error('Błąd:', error);
    }
}

processEmails();