import { fetchPoolDiscoveryPage } from "./tools/screening.js";
import { config } from "./config.js";

async function main() {
    const s = config.screening;
    const filters = [
        "base_token_has_critical_warnings=false",
        "quote_token_has_critical_warnings=false",
        s.excludeHighSupplyConcentration ? "base_token_has_high_supply_concentration=false" : null,
        "base_token_has_high_single_ownership=false",
        "pool_type=dlmm",
        `base_token_market_cap>=${s.minMcap}`,
        `base_token_market_cap<=${s.maxMcap}`,
        `base_token_holders>=${s.minHolders}`,
        `volume>=${s.minVolume}`,
        `tvl>=${s.minTvl}`,
        s.maxTvl != null ? `tvl<=${s.maxTvl}` : null,
        `dlmm_bin_step>=${s.minBinStep}`,
        `dlmm_bin_step<=${s.maxBinStep}`,
    ].filter(Boolean).join("&&");

    console.log("FILTERS SENT TO API:", filters);
    const data = await fetchPoolDiscoveryPage({
        page_size: 50,
        filters,
        timeframe: s.timeframe,
        category: s.category,
    });

    console.log("DATA RETURNED FROM API:", data ? (data.data ? data.data.length : "no data.data") : "null data");
}

main().catch(console.error);
