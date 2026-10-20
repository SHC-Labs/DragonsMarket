// A local chain with the contracts deployed and six markets in different states, for looking at the website.
// Not a real test: it is ignored by default and keeps running until the time is up.
//   cargo test -p tests --test dev_chain -- --ignored --nocapture
// Writes contracts/dev-chain.json with the RPC address and account ids, then waits (DEV_CHAIN_SECS, default 900).
mod common;
use common::*;
use near_workspaces::types::Gas;
use serde_json::json;

struct Spec {
    title: &'static str,
    source: &'static str,
    void_policy: &'static str,
    category: &'static str,
    sub: &'static str,
    close_in_secs: u64,
}

const DAY: u64 = 24 * 3600;

// What is happening now (October 2026): the first six are the resolution-state demos, the rest are open markets.
const SPECS: [Spec; 21] = [
    Spec {
        title: "Will the Fed raise rates at its next meeting?",
        source: "https://www.federalreserve.gov/newsevents/pressreleases.htm",
        void_policy: "The meeting is cancelled or postponed past 31 December.",
        category: "economy",
        sub: "fed",
        close_in_secs: 30 * DAY,
    },
    Spec {
        title: "Will bitcoin close above 85,000 USD today?",
        source: "Median of the closing prices on three major exchanges",
        void_policy: "Fewer than two of the three exchanges publish a closing price.",
        category: "crypto",
        sub: "bitcoin",
        close_in_secs: 240,
    },
    Spec {
        title: "Will the Yankees beat the Rays tonight?",
        source: "https://www.mlb.com/scores",
        void_policy: "The game is postponed or suspended and not completed within 3 days.",
        category: "sports",
        sub: "mlb",
        close_in_secs: 240,
    },
    Spec {
        title: "Will Tropical Storm Isaias become a hurricane by Friday?",
        source: "https://www.nhc.noaa.gov",
        void_policy: "The storm dissipates before Friday without ever reaching hurricane strength.",
        category: "world",
        sub: "weather",
        close_in_secs: 240,
    },
    Spec {
        title: "Will Houston's high temperature exceed 80F today?",
        source: "National Weather Service daily summary",
        void_policy: "The summary is not published within 7 days.",
        category: "world",
        sub: "weather",
        close_in_secs: 240,
    },
    Spec {
        title: "Will Gemini 4 be released to the public by 15 October?",
        source: "https://blog.google",
        void_policy: "Google withdraws the announcement before the date.",
        category: "tech",
        sub: "ai",
        close_in_secs: 240,
    },
    Spec {
        title: "Will Republicans keep control of the Senate after the November midterms?",
        source: "Associated Press race calls",
        void_policy: "Control is not decided by 31 January 2027.",
        category: "politics",
        sub: "congress",
        close_in_secs: 40 * DAY,
    },
    Spec {
        title: "Will Democrats win the House in the 2026 midterms?",
        source: "Associated Press race calls",
        void_policy: "Control is not decided by 31 January 2027.",
        category: "politics",
        sub: "us-elections",
        close_in_secs: 40 * DAY,
    },
    Spec {
        title: "Will Netanyahu be Israel's next prime minister?",
        source: "Israel Central Elections Committee",
        void_policy: "The election is cancelled or postponed past 31 March 2027.",
        category: "politics",
        sub: "world-elections",
        close_in_secs: 45 * DAY,
    },
    Spec {
        title: "Will Flavio Bolsonaro win the Brazil presidential runoff?",
        source: "TSE, Brazil's electoral court",
        void_policy: "The runoff is cancelled or postponed past 31 December.",
        category: "politics",
        sub: "world-elections",
        close_in_secs: 20 * DAY,
    },
    Spec {
        title: "Will the Chiefs win the 2027 Super Bowl?",
        source: "https://www.nfl.com",
        void_policy: "The game is not played by 28 February 2027.",
        category: "sports",
        sub: "nfl",
        close_in_secs: 120 * DAY,
    },
    Spec {
        title: "Will the Lakers win the 2027 NBA championship?",
        source: "https://www.nba.com",
        void_policy: "The Finals are not completed by 30 June 2027.",
        category: "sports",
        sub: "nba",
        close_in_secs: 200 * DAY,
    },
    Spec {
        title: "Will Verstappen win the 2026 F1 drivers' championship?",
        source: "https://www.fia.com",
        void_policy: "The season is cancelled before the final race.",
        category: "sports",
        sub: "f1",
        close_in_secs: 60 * DAY,
    },
    Spec {
        title: "Will Arsenal win the 2026-27 Premier League?",
        source: "https://www.premierleague.com",
        void_policy: "The season is abandoned.",
        category: "sports",
        sub: "soccer",
        close_in_secs: 220 * DAY,
    },
    Spec {
        title: "Will the 2030 World Cup open with a match in Uruguay?",
        source: "https://www.fifa.com",
        void_policy: "FIFA announces no opening match before 31 December 2029.",
        category: "sports",
        sub: "world-cup",
        close_in_secs: 300 * DAY,
    },
    Spec {
        title: "Will bitcoin reach 100,000 USD before 2027?",
        source: "Median of the prices on three major exchanges",
        void_policy: "Fewer than two of the three exchanges publish a price.",
        category: "crypto",
        sub: "bitcoin",
        close_in_secs: 80 * DAY,
    },
    Spec {
        title: "Will NEAR Intents pass 30 billion USD in all-time volume by year end?",
        source: "The public NEAR Intents dashboard",
        void_policy: "The dashboard is unavailable on 31 December.",
        category: "crypto",
        sub: "near",
        close_in_secs: 80 * DAY,
    },
    Spec {
        title: "Will the 30-year mortgage rate exceed 7.5% in November?",
        source: "Freddie Mac weekly survey",
        void_policy: "Freddie Mac does not publish a November survey.",
        category: "economy",
        sub: "housing",
        close_in_secs: 50 * DAY,
    },
    Spec {
        title: "Will WTI crude touch 85 USD in October?",
        source: "CME settlement prices",
        void_policy: "The CME does not publish settlements for the period.",
        category: "economy",
        sub: "oil",
        close_in_secs: 22 * DAY,
    },
    Spec {
        title: "Will Rockstar release another GTA VI trailer by 31 October?",
        source: "Rockstar Games official channels",
        void_policy: "Rockstar announces a new release date and no trailer before the deadline.",
        category: "tech",
        sub: "gaming",
        close_in_secs: 22 * DAY,
    },
    Spec {
        title: "Will Tom Cruise be nominated for Best Actor at the 2027 Oscars?",
        source: "Academy of Motion Picture Arts and Sciences",
        void_policy: "The ceremony is cancelled.",
        category: "culture",
        sub: "awards",
        close_in_secs: 100 * DAY,
    },
];

async fn make(w: &World, index: usize) -> anyhow::Result<u64> {
    let spec = &SPECS[index];
    let t = now(&w.worker).await;
    let close_at = t + spec.close_in_secs * 1_000_000_000;
    let id: String = w
        .owner
        .call(w.market.id(), "create_market")
        .args_json(json!({
            "title": spec.title,
            "rule_text": format!("Resolves Yes if the answer to \"{}\" is yes according to the source below when the market closes. Resolves No otherwise.", spec.title),
            "resolution_source": spec.source,
            "void_policy": spec.void_policy,
            "category": spec.category,
            "subcategory": spec.sub,
            "close_at": close_at.to_string(),
            "resolve_by": (close_at + 7 * 24 * 3_600_000_000_000u64).to_string()
        }))
        .gas(Gas::from_tgas(100))
        .transact()
        .await?
        .into_result()?
        .json()?;
    let id: u64 = id.parse()?;
    ft_call(w, &w.owner, w.market.id(), SEED, &format!("seed:{id}")).await?;
    // Trades with a different mix per market, so each chart has a shape. States markets get a few more.
    let plan: [(bool, u128); 6] = [(true, 4), (false, 2), (true, 6), (false, 3), (true, 2), (false, 5)];
    let take = if index < 6 { 6 } else { 4 };
    for (i, (yes, amount)) in plan.iter().take(take).enumerate() {
        if (i + index).is_multiple_of(3) && index >= 6 {
            continue;
        }
        let (who, side) = if *yes { (&w.alice, "yes") } else { (&w.bob, "no") };
        buy(w, who, id, side, amount * USD).await?;
    }
    Ok(id)
}

#[tokio::test]
#[ignore]
async fn dev_chain() -> anyhow::Result<()> {
    let w = setup_with(600_000, 1_800_000, DRAW_DELAY_BLOCKS).await?; // 10 minute challenge window, 30 minute panel deadline
                                                                      // Enough play money for the demo trades.
    for who in [&w.owner, &w.alice, &w.bob] {
        w.owner
            .call(w.ft.id(), "mint")
            .args_json(json!({ "account_id": who.id(), "amount": (3000 * USD).to_string() }))
            .transact()
            .await?
            .into_result()?;
    }
    let mut ids = vec![];
    for i in 0..SPECS.len() {
        ids.push(make(&w, i).await?);
    }
    assert_eq!(ids, (0..SPECS.len() as u64).collect::<Vec<_>>());
    let (m_open, m_proposed, m_disputed, m_verdict, m_nobody, m_final_yes) = (0, 1, 2, 3, 4, 5);

    skip_secs(&w.worker, 260).await; // the five short markets close

    // Market 5: an answer nobody challenges, finalised. Alice (Yes) can redeem.
    propose(&w, &w.carol, m_final_yes, "yes").await?;
    skip_secs(&w.worker, 620).await;
    finalize(&w, m_final_yes).await?;

    // Market 3: challenged, decided by a drawn jury. Bob (No) can redeem.
    propose(&w, &w.carol, m_verdict, "yes").await?;
    challenge(&w, &w.dave, m_verdict).await?;
    let jury = draw_jury(&w, m_verdict).await?;
    commit(&w, &jury[0], m_verdict, "no", "dev-chain-0").await?;
    commit(&w, &jury[1], m_verdict, "no", "dev-chain-1").await?;
    to_reveal_phase(&w, m_verdict).await;
    reveal(
        &w,
        &jury[0],
        m_verdict,
        "no",
        "dev-chain-0",
        "The hurricane centre's advisory still lists it as a tropical storm.",
    )
    .await?;
    reveal(
        &w,
        &jury[1],
        m_verdict,
        "no",
        "dev-chain-1",
        "No hurricane advisory was issued before the deadline.",
    )
    .await?;

    // Market 2: challenged, jury drawn, one hidden vote in.
    propose(&w, &w.carol, m_disputed, "yes").await?;
    challenge(&w, &w.dave, m_disputed).await?;
    let jury = draw_jury(&w, m_disputed).await?;
    commit(&w, &jury[0], m_disputed, "yes", "dev-chain-2").await?;

    // Market 1: answer proposed, challenge window open. Market 4: closed, nobody has proposed.
    propose(&w, &w.carol, m_proposed, "no").await?;

    assert_eq!(case_json(&w, m_final_yes).await["final_outcome"], "yes");
    assert_eq!(case_json(&w, m_verdict).await["final_outcome"], "no");
    let disputed = case_json(&w, m_disputed).await;
    assert_eq!(
        (disputed["stage"].as_str(), disputed["commits"].as_array().map(Vec::len)),
        (Some("disputed"), Some(1))
    );
    assert_eq!(case_json(&w, m_proposed).await["stage"], "proposed");
    assert!(case_json(&w, m_nobody).await.is_null() && case_json(&w, m_open).await.is_null());

    let out = json!({
        "rpc": format!("http://{}", w.worker.rpc_addr().trim_start_matches("http://")),
        "market": w.market.id(), "oracle": w.oracle.id(), "council": w.council.id(), "token": w.ft.id(), "nft": w.nft.id(),
        "count": SPECS.len(),
        "markets": { "open": m_open, "proposed": m_proposed, "disputed": m_disputed, "verdict": m_verdict, "nobody": m_nobody, "final_yes": m_final_yes },
        "accounts": { "owner": w.owner.id(), "alice": w.alice.id(), "bob": w.bob.id(), "carol": w.carol.id(), "dave": w.dave.id(),
                      "jurors": w.jurors.iter().map(|j| j.id().to_string()).collect::<Vec<_>>() }
    });
    let path = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../dev-chain.json");
    std::fs::write(&path, serde_json::to_string_pretty(&out)?)?;
    println!("DEV_CHAIN_READY {}", path.display());

    let secs: u64 = std::env::var("DEV_CHAIN_SECS")
        .ok()
        .and_then(|s| s.parse().ok())
        .unwrap_or(900);
    tokio::time::sleep(std::time::Duration::from_secs(secs)).await;
    Ok(())
}
