-- AlterTable
ALTER TABLE `internalmessages` ADD COLUMN `client_id` INTEGER NULL;

-- AddForeignKey
ALTER TABLE `internalmessages` ADD CONSTRAINT `internalmessages_client_id_fkey` FOREIGN KEY (`client_id`) REFERENCES `clients`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;
