import { DataResponse } from "./types/response.types";
import ApiClient from "./api-client";
import { Wallet } from "./types/wallet.types";

export default class WalletsClient extends ApiClient {

    public async createWallet(name: string) {
        try {
            const response = await this.ax.post<DataResponse<Wallet>>(
                `/api/wallets`,
                { name }
            );
            return response.data.data
        } catch (error) {
            throw new Error("Failed to create wallet", { cause: error });
        }
    }

    public async deleteWallet(walletId: number) {
        try {
            const response = await this.ax.delete<DataResponse<Wallet>>(
                `/api/wallets/${walletId}`
            )
            return response.data.data
        } catch (error) {
            throw new Error("Failed to delete wallet", { cause: error });
        }
    }

    public async updateWalletName(id: number, newName: string) {
        try {
            const response = await this.ax.put<DataResponse<Wallet>>(
                `/api/wallets/${id}/name`,
                { newName }
            )
            return response.data.data
        } catch (error) {
            throw new Error("Failed to update wallet name", { cause: error });
        }
    }

    public async addUserToWallet(walletId: number, userId: number) {
        try {
            const response = await this.ax.post<DataResponse<Wallet>>(
                `/api/wallets/${walletId}/users`,
                { userId }
            )
            return response.data.data
        } catch (error) {
            throw new Error("Failed to add user to wallet", { cause: error });
        }
    }

    public async removeUserFromWallet(walletId: number, userId: number) {
        try {
            const response = await this.ax.delete<DataResponse<Wallet>>(
                `/api/wallets/${walletId}/users/${userId}`
            )
            return response.data.data
        } catch (error) {
            throw new Error("Failed to remove user from wallet", { cause: error });
        }
    }

    public async getWallets() {
        try {
            const response = await this.ax.get<DataResponse<Wallet[]>>(
                "/api/wallets"
            )
            return response.data.data
        } catch (error) {
            throw new Error("Failed to get wallets list", { cause: error });
        }
    }

    public async getWalletById(walletId: number) {
        try {
            const response = await this.ax.get<DataResponse<Wallet>>(
                `/api/wallets/${walletId}`
            )
            return response.data.data
        } catch (error) {
            throw new Error("Failed to get wallet", { cause: error });
        }
    }

    public async getWalletUsers(walletId: number) {
        try {
            const response = await this.ax.get<DataResponse<Wallet>>(
                `/api/wallets/${walletId}/users`
            )
            return response.data.data
        } catch (error) {
            throw new Error("Failed to get wallet users list", { cause: error });
        }
    }

    public async getUserInWallet(walletId: number, userId: number) {
        try {
            const response = await this.ax.get<DataResponse<Wallet>>(
                `/api/wallets/${walletId}/users/${userId}`
            )
            return response.data.data
        } catch (error) {
            throw new Error("Failed to get user from wallet", { cause: error });
        }
    }

    public async getUserWallets(instance: string, userId: number) {
        try {
            const response = await this.ax.get<DataResponse<Wallet[]>>(
                `/api/users/${userId}/wallets`,
                { params: { instance } }
            );
            return response.data.data
        } catch (error) {
            throw new Error("Failed to get user wallets list", { cause: error });
        }
    }

    public setAuth(token: string) {
        this.ax.defaults.headers.common["Authorization"] =
            `Bearer ${token}`;
    }
}