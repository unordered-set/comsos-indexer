import axios, { AxiosError } from "axios";
import { NetworkManager } from "./networkManager";
import { defaultRegistryUrls, isFulfilled } from "./constants";
import { apiToSmallInt, tryParseJson } from "./helpers";
import { CantGetBlockHeaderErr, CantGetLatestHeightErr } from "./errors";
import { fromBase64 } from "@cosmjs/encoding";

const timeToSync = 200;

export class ApiManager {
    readonly manager: NetworkManager;

    constructor(manager: NetworkManager) {
        this.manager = manager;
    }

    static async createApiManager(network: string, registryUrls: string[] = defaultRegistryUrls) {
        return new ApiManager(await NetworkManager.create(network, registryUrls));
    }

    async getLatestHeight(lastKnownHeight: number = 0): Promise<number> {
        let endpoints = this.manager.getEndpoints("rest");

        let results = await Promise.allSettled(endpoints.map(async endp => {
            try {
                let url = `${endp}/cosmos/base/tendermint/v1beta1/blocks/latest`
                let result = await axios.get(url, { timeout: 2000 });

                return parseInt(result?.data?.block?.header?.height);
            } catch (err: any) {
                if (err instanceof AxiosError)
                    this.manager.reportStats({ type: "rest", url: endp }, false);

                return Promise.reject(err?.message);
            }
        }));

        let success = results.filter(isFulfilled).map(x => x.value) as number[];
        let result = Math.max(...success, lastKnownHeight);

        if (result === 0)
            throw new CantGetLatestHeightErr(this.manager.network, endpoints);

        return result;
    }

    async getBlockHeader(height: number): Promise<BlockHeader> {
        let endpoints = this.manager.getEndpoints("rpc");

        for (const rpc of endpoints) {
            try {
                let url = `${rpc}/block?height=${height}`
                let { data } = await axios({
                    method: "GET",
                    url,
                    timeout: 2000
                });

                this.manager.reportStats({ type: "rpc", url: rpc }, true);
                let header = data.result.block.header;

                return {
                    height: parseInt(header.height),
                    time: new Date(header.time),
                    hash: data.result.block_id.hash,
                    chainId: data.result.block.chain_id,
                    operatorAddress: data.result.block.header.proposer_address
                }
            } catch (err: any) {
                if (err instanceof AxiosError)
                    this.manager.reportStats({ type: "rpc", url: rpc }, false);

                let msg = `Error fetching height in ${this.manager.network} rpc ${rpc} error : ${err?.message}`;
                console.log(new Error(msg));
            }
        }

        throw new CantGetBlockHeaderErr(this.manager.network, height, endpoints);
    }

    async getTxsInBlock(height: number): Promise<Tx[]> {
        let endpoints = this.manager.getEndpoints("rpc");
        let errors = 0;
        let emptyResults = 0;

        for (const rpc of endpoints) {
            try {
                let allTxs: RawTx[] = [];
                let totalTxs: number;
                let page = 1;

                do {
                    let url = `${rpc}/tx_search?query="tx.height%3D${height}"&page=${page++}`
                    let { data: { result } }: { data: { result: TxsResponse } } =
                        await axios({
                            method: "GET",
                            url,
                            timeout: 2000
                        });

                    totalTxs = result.total_count;
                    allTxs.push(...result.txs);
                }
                while (allTxs.length < totalTxs)

                let result: Tx[] = allTxs.map(this.decodeTx);

                if (result.length !== 0)
                    return result;

                await new Promise(res => setTimeout(res, timeToSync));
                emptyResults++;
                this.manager.reportStats({ type: "rpc", url: rpc }, true);
            } catch (err: any) {
                if (err instanceof AxiosError)
                    this.manager.reportStats({ type: "rpc", url: rpc }, false);

                errors++;
            }
        }

        //probably, that's empty block
        return [];

        //throw new CantGetTxsInBlockErr(this.manager.network, height, endpoints);
    }

    //Performs basic decoding, without protobuf
    decodeTx(data: RawTx): Tx {
        return {
            tx: fromBase64(data.tx || ""),
            code: apiToSmallInt(data.tx_result.code) || 0,
            events: data.tx_result.events.map(ev => {
                return {
                    type: ev.type,
                    attributes: ev.attributes.map(attr => {
                        return {
                            key: new TextDecoder().decode(fromBase64(attr.key || "")),
                            value: new TextDecoder().decode(fromBase64(attr.value || ""))
                        }
                    })
                }
            }),
            log: tryParseJson(data.tx_result.log),
            hash: data.hash,
            data: fromBase64(data.tx_result.data || ""),
            index: data.index
        }
    }
}

export interface TallyResult {
    yes: number,
    abstain: number,
    no: number,
    no_with_veto: number
}

export interface Tx {
    tx?: Uint8Array;
    code: number;
    log: string;
    data?: Uint8Array;
    events: {
        type: string,
        attributes: {
            key?: string,
            value?: string
        }[]
    }[];
    index: number;
    hash: string;
}

interface TxsResponse {
    txs: RawTx[],
    total_count: number
}

export interface BlockHeader {
    height: number,
    time: Date,
    hash: string,
    chainId: string,
    operatorAddress: string
}

interface RawTx {
    tx?: string;
    tx_result: {
        code: number;
        log: string;
        data?: string;
        events: {
            type: string,
            attributes: {
                key?: string,
                value?: string
            }[]
        }[];
    };
    height: string;
    index: number;
    hash: string;
}