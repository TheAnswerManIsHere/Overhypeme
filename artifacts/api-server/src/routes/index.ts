import { Router, type IRouter } from "express";
import healthRouter from "./health";
import authRouter from "./auth";
import factsRouter from "./facts";
import hashtagsRouter from "./hashtags";
import usersRouter from "./users";

const router: IRouter = Router();

router.use(healthRouter);
router.use(authRouter);
router.use(factsRouter);
router.use(hashtagsRouter);
router.use(usersRouter);

export default router;
