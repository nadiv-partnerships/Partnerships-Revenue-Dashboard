// api/data.js — Vercel serverless function
// Queries CData Connect AI via TDS (SQL Server protocol)
//
// Required Vercel environment variables:
//   CDATA_USER  — your CData Connect AI login email
//   CDATA_PAT   — your CData Connect AI Personal Access Token (Settings → PATs)

const sql = require('mssql');

const PARTNER_SOURCES = `('Inbound - Partner','Partner - Resell','Outbound - Partner','Partnerships')`;
const START_DATE = '2026-01-01';
const CONN = 'Salesforce1';

let pool = null;

async function getPool() {
  // Re-use warm pool; reconnect on error
  if (pool) {
    try { await pool.request().query('SELECT 1'); return pool; }
    catch (e) { pool = null; }
  }
  pool = await sql.connect({
    server: 'tds.cdata.com',
    port: 14333,
    user: process.env.CDATA_USER,
    password: process.env.CDATA_PAT,
    options: {
      encrypt: true,
      database: CONN,
      trustServerCertificate: false,
    },
    connectionTimeout: 20000,
    requestTimeout: 45000,
  });
  return pool;
}

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  // Cache 5 minutes at CDN edge; clients always get fresh on hard-reload
  res.setHeader('Cache-Control', 's-maxage=300, stale-while-revalidate=60');

  if (req.method === 'OPTIONS') return res.status(200).end();

  try {
    const p = await getPool();
    const Q = (q) => p.request().query(q);

    const [lbRes, rilletRes, plChartRes, plRes, referralRes] = await Promise.all([

      // 1. Partner CW ARR by partner + close month  →  lbRows + raw monthly totals
      Q(`SELECT FORMAT(o.[CloseDate],'yyyy-MM') as month,
                a.[Name] as partner,
                SUM(o.[cARR__c]) as arr,
                COUNT(*) as deals
         FROM [${CONN}].[Salesforce].[Opportunity] o
         LEFT JOIN [${CONN}].[Salesforce].[Account] a
                ON o.[Relevant_Partner__c] = a.[Id]
         WHERE o.[StageName] = 'Closed Won'
           AND o.[LeadSource] IN ${PARTNER_SOURCES}
           AND o.[CloseDate] >= '${START_DATE}'
           AND o.[CloseDate] >= o.[CreatedDate]
           AND o.[Relevant_Partner__c] IS NOT NULL
           AND o.[Relevant_Partner__c] NOT LIKE '0018a%'
         GROUP BY FORMAT(o.[CloseDate],'yyyy-MM'), a.[Name]
         ORDER BY month, arr DESC`),

      // 2. Total Rillet CW ARR by close month  →  % of revenue chart denominator
      Q(`SELECT FORMAT([CloseDate],'yyyy-MM') as month,
                SUM([cARR__c]) as arr
         FROM [${CONN}].[Salesforce].[Opportunity]
         WHERE [StageName] = 'Closed Won'
           AND [CloseDate] >= '${START_DATE}'
           AND [CloseDate] >= [CreatedDate]
         GROUP BY FORMAT([CloseDate],'yyyy-MM')
         ORDER BY month`),

      // 3. Partner pipeline by CREATE month  →  "pipeline sourced" area chart
      Q(`SELECT FORMAT(o.[CreatedDate],'yyyy-MM') as month,
                SUM(o.[cARR__c]) as arr,
                COUNT(*) as cnt
         FROM [${CONN}].[Salesforce].[Opportunity] o
         WHERE o.[LeadSource] IN ${PARTNER_SOURCES}
           AND o.[CreatedDate] >= '${START_DATE}'
           AND o.[CloseDate] >= o.[CreatedDate]
           AND o.[Relevant_Partner__c] IS NOT NULL
           AND o.[Relevant_Partner__c] NOT LIKE '0018a%'
         GROUP BY FORMAT(o.[CreatedDate],'yyyy-MM')
         ORDER BY month`),

      // 4. Open pipeline by CloseDate + partner  →  plRows / pipeline type table
      Q(`SELECT FORMAT(o.[CloseDate],'yyyy-MM') as month,
                a.[Name] as partner,
                SUM(o.[cARR__c]) as arr,
                COUNT(*) as opps
         FROM [${CONN}].[Salesforce].[Opportunity] o
         LEFT JOIN [${CONN}].[Salesforce].[Account] a
                ON o.[Relevant_Partner__c] = a.[Id]
         WHERE o.[StageName] NOT IN ('Closed Won','Closed Lost')
           AND o.[LeadSource] IN ${PARTNER_SOURCES}
           AND o.[CloseDate] >= '${START_DATE}'
           AND o.[CloseDate] >= o.[CreatedDate]
           AND o.[Relevant_Partner__c] IS NOT NULL
           AND o.[Relevant_Partner__c] NOT LIKE '0018a%'
         GROUP BY FORMAT(o.[CloseDate],'yyyy-MM'), a.[Name]
         ORDER BY month, arr DESC`),

      // 5. Distinct active partners per create month  →  referral activity chart
      Q(`SELECT FORMAT(o.[CreatedDate],'yyyy-MM') as month,
                COUNT(DISTINCT o.[Relevant_Partner__c]) as partners
         FROM [${CONN}].[Salesforce].[Opportunity] o
         WHERE o.[LeadSource] IN ${PARTNER_SOURCES}
           AND o.[CreatedDate] >= '${START_DATE}'
           AND o.[Relevant_Partner__c] IS NOT NULL
           AND o.[Relevant_Partner__c] NOT LIKE '0018a%'
         GROUP BY FORMAT(o.[CreatedDate],'yyyy-MM')
         ORDER BY month`),
    ]);

    res.status(200).json({
      lb:          lbRes.recordset,       // [{month, partner, arr, deals}]
      rillet:      rilletRes.recordset,   // [{month, arr}]
      plChart:     plChartRes.recordset,  // [{month, arr, cnt}]  — CreatedDate
      pl:          plRes.recordset,       // [{month, partner, arr, opps}]
      referral:    referralRes.recordset, // [{month, partners}]
      generatedAt: new Date().toISOString(),
    });

  } catch (err) {
    console.error('api/data error:', err.message);
    pool = null; // force reconnect next call
    res.status(500).json({ error: err.message });
  }
};
