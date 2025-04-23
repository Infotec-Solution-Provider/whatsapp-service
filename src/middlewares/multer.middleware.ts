import multer from "multer";

const upload = multer({
	limits: {
		fileSize: 1024 * 1024 * 128 // 128MB
	}
});

export default upload;
