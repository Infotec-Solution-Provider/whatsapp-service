/*
  Warnings:

  - A unique constraint covering the columns `[instance,whatsapp_id]` on the table `contacts` will be added. If there are existing duplicate values, this will fail.

*/
-- AlterTable
ALTER TABLE `contacts` ADD COLUMN `whatsapp_id` VARCHAR(191) NULL,
    MODIFY `phone` VARCHAR(191) NULL;

-- CreateIndex
CREATE UNIQUE INDEX `contacts_instance_whatsapp_id_key` ON `contacts`(`instance`, `whatsapp_id`);
