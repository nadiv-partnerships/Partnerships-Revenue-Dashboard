// api/data.js — Vercel serverless function
// Queries CData Connect AI via TDS (SQL Server protocol)
//
// Required Vercel environment variables:
//   CDATA_USER  — your CData Connect AI login email
//   CDATA_PAT   — your CData Connect AI Personal Access Token (Settings → PATs)
//
// Timezone: Salesforce CreatedDate is stored UTC. All CreatedDate groupings
// are shifted by -7h (PDT) so month/day buckets align with Pacific Time.
// CloseDate is a date-only field (no time component) and needs no adjustment.

const sql = require('mssql');

const PARTNER_SOURCES = `('Inbound - Partner','Partner - Resell','Outbound - Partner','Partnerships','Event - Partner Hosted')`;
const START_DATE = '2026-01-01';
const CONN = 'Salesforce1';

// Convert a UTC datetime column to Pacific Time (PDT = UTC-7) before formatting.
// Use this wrapper for every CreatedDate grouping; CloseDate is date-only, no wrapper needed.
const PT = (col) => `DATEADD(hour,-7,${col})`;

// Partner name helper: NULL or person-account (0018a...) → 'Unattributed'
const PARTNER_NAME = `CASE WHEN o.[Relevant_Partner__c] IS NULL OR o.[Relevant_Partner__c] LIKE '0018a%'
                           THEN 'Unattributed' ELSE a.[Name] END`;

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
    connectionTimeout: 10000,
    requestTimeout: 25000,
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
    // safeQ: runs a query and returns recordset, or [] on failure (for optional fields)
    const Q    = (q) => p.request().query(q).then(r => r.recordset);
    const safeQ = (q) => Q(q).catch(e => { console.warn('query skipped:', e.message); return []; });

    // Run ALL queries in a single Promise.all — eliminates sequential batch overhead.
    // ALL queries use safeQ so a single slow/failed query returns [] instead of crashing everything.
    const [
      lbRec,          // 1
      rilletRec,      // 2
      plChartRec,     // 3
      plRec,          // 4
      referralRec,    // 5
      splitRec,       // 6
      cohortRec,      // 7
      allDealsRec,    // 8
      rilletCohortRec,// 9
      rilletTotalRec, // 10
      influenceRec,   // 11
      dailyCWRec,     // 12
      dailyPipeRec,   // 13
      dailyCWAllRec,  // 14
      dailyPipeAllRec,// 15
      influencedJunctionRec, // 16
      influencePartnerLBRec, // 17
    ] = await Promise.all([

      // 1. Partner CW ARR by partner + close month
      safeQ(`SELECT FORMAT(o.[CloseDate],'yyyy-MM') as month,
                ${PARTNER_NAME} as partner,
                SUM(o.[cARR__c]) as arr,
                COUNT(*) as deals
         FROM [${CONN}].[Salesforce].[Opportunity] o
         LEFT JOIN [${CONN}].[Salesforce].[Account] a
                ON o.[Relevant_Partner__c] = a.[Id]
         WHERE o.[StageName] = 'Closed Won'
           AND o.[LeadSource] IN ${PARTNER_SOURCES}
           AND o.[CloseDate] >= '${START_DATE}'
           AND o.[CloseDate] >= o.[CreatedDate]
         GROUP BY FORMAT(o.[CloseDate],'yyyy-MM'),
                  ${PARTNER_NAME}
         ORDER BY month, arr DESC`),

      // 2. Total Rillet CW ARR + deal count by close month
      safeQ(`SELECT FORMAT([CloseDate],'yyyy-MM') as month,
                SUM([cARR__c]) as arr,
                COUNT(*) as deals
         FROM [${CONN}].[Salesforce].[Opportunity]
         WHERE [StageName] = 'Closed Won'
           AND [CloseDate] >= '${START_DATE}'
           AND [CloseDate] >= [CreatedDate]
         GROUP BY FORMAT([CloseDate],'yyyy-MM')
         ORDER BY month`),

      // 3. All originated opps by create month → pipeline sourced area chart
      safeQ(`SELECT FORMAT(${PT('o.[CreatedDate]')},'yyyy-MM') as month,
                SUM(o.[cARR__c]) as arr,
                COUNT(*) as cnt
         FROM [${CONN}].[Salesforce].[Opportunity] o
         WHERE o.[LeadSource] IN ${PARTNER_SOURCES}
           AND o.[CreatedDate] >= '${START_DATE}'
           AND o.[Relevant_Partner__c] IS NOT NULL
         GROUP BY FORMAT(${PT('o.[CreatedDate]')},'yyyy-MM')
         ORDER BY month`),

      // 4. All originated opps by CreatedDate + partner
      safeQ(`SELECT FORMAT(${PT('o.[CreatedDate]')},'yyyy-MM') as month,
                ${PARTNER_NAME} as partner,
                SUM(o.[cARR__c]) as arr,
                COUNT(*) as opps
         FROM [${CONN}].[Salesforce].[Opportunity] o
         LEFT JOIN [${CONN}].[Salesforce].[Account] a
                ON o.[Relevant_Partner__c] = a.[Id]
         WHERE o.[LeadSource] IN ${PARTNER_SOURCES}
           AND o.[CreatedDate] >= '${START_DATE}'
           AND o.[Relevant_Partner__c] IS NOT NULL
         GROUP BY FORMAT(${PT('o.[CreatedDate]')},'yyyy-MM'),
                  ${PARTNER_NAME}
         ORDER BY month, arr DESC`),

      // 5. Distinct active company partners per create month
      safeQ(`SELECT FORMAT(${PT('o.[CreatedDate]')},'yyyy-MM') as month,
                COUNT(DISTINCT o.[Relevant_Partner__c]) as partners
         FROM [${CONN}].[Salesforce].[Opportunity] o
         WHERE o.[LeadSource] IN ${PARTNER_SOURCES}
           AND o.[CreatedDate] >= '${START_DATE}'
           AND o.[Relevant_Partner__c] IS NOT NULL
           AND o.[Relevant_Partner__c] NOT LIKE '0018a%'
         GROUP BY FORMAT(${PT('o.[CreatedDate]')},'yyyy-MM')
         ORDER BY month`),

      // 6. All opps by create month + inbound/resell → split chart
      safeQ(`SELECT FORMAT(${PT('o.[CreatedDate]')},'yyyy-MM') as month,
                CASE WHEN o.[LeadSource] = 'Partner - Resell' THEN 'resell' ELSE 'inbound' END as type,
                COUNT(*) as deals,
                SUM(o.[cARR__c]) as arr
         FROM [${CONN}].[Salesforce].[Opportunity] o
         WHERE o.[LeadSource] IN ${PARTNER_SOURCES}
           AND o.[CreatedDate] >= '${START_DATE}'
           AND o.[Relevant_Partner__c] IS NOT NULL
         GROUP BY FORMAT(${PT('o.[CreatedDate]')},'yyyy-MM'),
                  CASE WHEN o.[LeadSource] = 'Partner - Resell' THEN 'resell' ELSE 'inbound' END
         ORDER BY month`),

      // 7. CW by cohort month + close month → revenue by origination lag chart
      safeQ(`SELECT FORMAT(${PT('o.[CreatedDate]')},'yyyy-MM') as cohort_month,
                FORMAT(o.[CloseDate],'yyyy-MM') as close_month,
                COUNT(*) as deals,
                SUM(o.[cARR__c]) as arr
         FROM [${CONN}].[Salesforce].[Opportunity] o
         WHERE o.[StageName] = 'Closed Won'
           AND o.[LeadSource] IN ${PARTNER_SOURCES}
           AND o.[CreatedDate] >= '${START_DATE}'
           AND o.[Relevant_Partner__c] IS NOT NULL
         GROUP BY FORMAT(${PT('o.[CreatedDate]')},'yyyy-MM'), FORMAT(o.[CloseDate],'yyyy-MM')
         ORDER BY cohort_month, close_month`),

      // 8. All opps (all stages) individual records → funnel table + pipeline accordion
      safeQ(`SELECT o.[Id], o.[Name], o.[StageName], o.[cARR__c], o.[LeadSource],
                ${PARTNER_NAME} as partner,
                FORMAT(${PT('o.[CreatedDate]')},'yyyy-MM') as create_month,
                FORMAT(o.[CloseDate],'yyyy-MM') as close_month
         FROM [${CONN}].[Salesforce].[Opportunity] o
         LEFT JOIN [${CONN}].[Salesforce].[Account] a ON o.[Relevant_Partner__c] = a.[Id]
         WHERE o.[LeadSource] IN ${PARTNER_SOURCES}
           AND o.[CreatedDate] >= '${START_DATE}'
           AND o.[Relevant_Partner__c] IS NOT NULL
         ORDER BY o.[CloseDate], o.[cARR__c] DESC`),

      // 9. All Rillet CW by cohort+close month → Rillet Overall cohort line (PT-adjusted)
      safeQ(`SELECT FORMAT(${PT('[CreatedDate]')},'yyyy-MM') as cohort_month,
                FORMAT([CloseDate],'yyyy-MM') as close_month,
                COUNT(*) as deals,
                SUM([cARR__c]) as arr
         FROM [${CONN}].[Salesforce].[Opportunity]
         WHERE [StageName] = 'Closed Won'
           AND [CreatedDate] >= '${START_DATE}'
           AND [CloseDate] >= [CreatedDate]
         GROUP BY FORMAT(${PT('[CreatedDate]')},'yyyy-MM'), FORMAT([CloseDate],'yyyy-MM')
         ORDER BY cohort_month, close_month`),

      // 10. All Rillet opps by create month → denominator for Rillet Overall line (PT-adjusted)
      safeQ(`SELECT FORMAT(${PT('[CreatedDate]')},'yyyy-MM') as month,
                COUNT(*) as deals
         FROM [${CONN}].[Salesforce].[Opportunity]
         WHERE [CreatedDate] >= '${START_DATE}'
         GROUP BY FORMAT(${PT('[CreatedDate]')},'yyyy-MM')
         ORDER BY month`),

      // 11. Sourced vs influenced CW by close month (uses Partner_Influenced__c custom field)
      safeQ(`SELECT FORMAT(o.[CloseDate],'yyyy-MM') as month,
               CASE WHEN o.[LeadSource] IN ${PARTNER_SOURCES} THEN 'sourced' ELSE 'influenced' END as type,
               COUNT(*) as deals,
               SUM(o.[cARR__c]) as arr
        FROM [${CONN}].[Salesforce].[Opportunity] o
        WHERE o.[StageName] = 'Closed Won'
          AND o.[CloseDate] >= '${START_DATE}'
          AND o.[CloseDate] >= o.[CreatedDate]
          AND (
            o.[LeadSource] IN ${PARTNER_SOURCES}
            OR o.[Partner_Influenced__c] = 1
          )
        GROUP BY FORMAT(o.[CloseDate],'yyyy-MM'),
                 CASE WHEN o.[LeadSource] IN ${PARTNER_SOURCES} THEN 'sourced' ELSE 'influenced' END
        ORDER BY month, type`),

      // 12. Daily partner CW ARR by day of month
      safeQ(`SELECT FORMAT([CloseDate],'yyyy-MM') as month,
                DAY([CloseDate]) as day,
                SUM([cARR__c]) as arr
         FROM [${CONN}].[Salesforce].[Opportunity]
         WHERE [StageName] = 'Closed Won'
           AND [LeadSource] IN ${PARTNER_SOURCES}
           AND [CloseDate] >= '${START_DATE}'
           AND [CloseDate] >= [CreatedDate]
         GROUP BY FORMAT([CloseDate],'yyyy-MM'), DAY([CloseDate])
         ORDER BY month, day`),

      // 13. Daily partner pipeline by day of month (PT-adjusted)
      safeQ(`SELECT FORMAT(${PT('[CreatedDate]')},'yyyy-MM') as month,
                DAY(${PT('[CreatedDate]')}) as day,
                SUM([cARR__c]) as arr
         FROM [${CONN}].[Salesforce].[Opportunity]
         WHERE [LeadSource] IN ${PARTNER_SOURCES}
           AND [CreatedDate] >= '${START_DATE}'
           AND [Relevant_Partner__c] IS NOT NULL
         GROUP BY FORMAT(${PT('[CreatedDate]')},'yyyy-MM'), DAY(${PT('[CreatedDate]')})
         ORDER BY month, day`),

      // 14. Daily ALL Rillet CW ARR by day of month
      safeQ(`SELECT FORMAT([CloseDate],'yyyy-MM') as month,
                DAY([CloseDate]) as day,
                SUM([cARR__c]) as arr
         FROM [${CONN}].[Salesforce].[Opportunity]
         WHERE [StageName] = 'Closed Won'
           AND [CloseDate] >= '${START_DATE}'
           AND [CloseDate] >= [CreatedDate]
           AND FORMAT([CloseDate],'yyyy-MM') <> '2027-05'
         GROUP BY FORMAT([CloseDate],'yyyy-MM'), DAY([CloseDate])
         ORDER BY month, day`),

      // 15. Daily ALL Rillet pipeline originated by day of month (PT-adjusted)
      safeQ(`SELECT FORMAT(${PT('[CreatedDate]')},'yyyy-MM') as month,
                DAY(${PT('[CreatedDate]')}) as day,
                SUM([cARR__c]) as arr
         FROM [${CONN}].[Salesforce].[Opportunity]
         WHERE [CreatedDate] >= '${START_DATE}'
         GROUP BY FORMAT(${PT('[CreatedDate]')},'yyyy-MM'), DAY(${PT('[CreatedDate]')})
         ORDER BY month, day`),

      // 16. Influenced CW by close month from junction object (safeQ — junction may not have all months)
      safeQ(`SELECT FORMAT(o.[CloseDate],'yyyy-MM') as month,
                  COUNT(DISTINCT o.[Id]) as deals,
                  SUM(o.[cARR__c]) as arr
           FROM [${CONN}].[Salesforce].[Partner_Influence__c] pi
           INNER JOIN [${CONN}].[Salesforce].[Opportunity] o ON pi.[Opportunity_Influenced__c] = o.[Id]
           WHERE o.[StageName] = 'Closed Won'
             AND o.[CloseDate] >= '${START_DATE}'
             AND o.[CloseDate] >= o.[CreatedDate]
             AND o.[LeadSource] NOT IN ${PARTNER_SOURCES}
             AND pi.[IsDeleted] = 0
           GROUP BY FORMAT(o.[CloseDate],'yyyy-MM')
           ORDER BY month`),

      // 17. Influenced CW by influencing partner + close month
      safeQ(`SELECT a.[Name] as partner,
                  FORMAT(o.[CloseDate],'yyyy-MM') as month,
                  COUNT(DISTINCT o.[Id]) as deals,
                  SUM(o.[cARR__c]) as arr
           FROM [${CONN}].[Salesforce].[Partner_Influence__c] pi
           INNER JOIN [${CONN}].[Salesforce].[Opportunity] o ON pi.[Opportunity_Influenced__c] = o.[Id]
           INNER JOIN [${CONN}].[Salesforce].[Account] a ON pi.[Influencing_Partner__c] = a.[Id]
           WHERE o.[StageName] = 'Closed Won'
             AND o.[CloseDate] >= '${START_DATE}'
             AND o.[CloseDate] >= o.[CreatedDate]
             AND pi.[IsDeleted] = 0
           GROUP BY a.[Name], FORMAT(o.[CloseDate],'yyyy-MM')
           ORDER BY month, arr DESC`),
    ]);

    res.status(200).json({
      lb:                 lbRec,
      rillet:             rilletRec,
      plChart:            plChartRec,
      pl:                 plRec,
      referral:           referralRec,
      split:              splitRec,
      cohort:             cohortRec,
      allDeals:           allDealsRec,
      influence:          influenceRec,
      influencedJunction: influencedJunctionRec,
      influencePartnerLB: influencePartnerLBRec,
      rilletCohort:       rilletCohortRec,
      rilletTotal:        rilletTotalRec,
      dailyCW:            dailyCWRec,
      dailyPipe:          dailyPipeRec,
      dailyCWAll:         dailyCWAllRec,
      dailyPipeAll:       dailyPipeAllRec,
      generatedAt: new Date().toISOString(),
    });

  } catch (err) {
    console.error('api/data error:', err.message);
    pool = null; // force reconnect next call
    res.status(500).json({ error: err.message });
  }
};
