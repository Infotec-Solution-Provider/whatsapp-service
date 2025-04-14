-- AlterTable
ALTER TABLE `wallets_users` ADD COLUMN `wppWalletId` INTEGER NULL;

-- AddForeignKey
ALTER TABLE `wallets_users` ADD CONSTRAINT `wallets_users_wppWalletId_fkey` FOREIGN KEY (`wppWalletId`) REFERENCES `wallets`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;
